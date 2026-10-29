/**
 * The game service (architecture §5.2): lobby, start, and the per-game serialised command
 * pipeline. Every response and push is projected for its recipient (§4.5).
 */
import { expand, validateDeck } from '@torn-signpost/cards';
import {
  type Actor,
  decide,
  ENGINE_VERSION,
  evolve,
  type GameEvent,
  type GameState,
  newGame,
  project,
  projectEvent,
  type Rng,
  shuffled,
  type Viewer,
  viewerFor,
} from '@torn-signpost/engine';
import type {
  CommandRequest,
  CommandResponse,
  CreateGameRequest,
  DeckCards,
  EventsResponse,
  GameDetails,
  GameSummary,
  JoinGameRequest,
  LobbyStatus,
  ServerMessage,
} from '@torn-signpost/protocol';
import type { Identity } from '../auth.ts';
import type { Content } from '../content/catalog.ts';
import type { GameMeta, GameStore } from '../db/store.ts';
import type { DeckService } from '../decks/service.ts';
import { ApiError } from '../errors.ts';

/** Delivers a message, built per recipient, to everyone watching a game. */
export interface Publisher {
  publish(gameId: string, build: (identity: Identity) => ServerMessage | undefined): Promise<void>;
}

export interface GameServiceDeps {
  store: GameStore;
  content: Content;
  /** For joining with a saved deck. */
  decks?: DeckService;
  rng: Rng;
  publisher: Publisher;
  newId: () => string;
  now?: () => Date;
}

const SNAPSHOT_EVERY = 25;
const MAX_ATTEMPTS = 3;
const CACHE_SIZE = 200;
const EVENTS_PAGE = 200;

type User = Extract<Identity, { kind: 'user' }>;
interface Step {
  before: GameState;
  ev: GameEvent;
  after: GameState;
}

export class GameService {
  /** Warm-Lambda cache of recent game states, keyed by game ID (§5.2). */
  private readonly cache = new Map<string, GameState>();
  private readonly now: () => Date;

  constructor(private readonly deps: GameServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async create(identity: Identity, req: CreateGameRequest): Promise<GameSummary> {
    const user = requireUser(identity);
    const [min, max] = req.format === 'duel' ? [2, 2] : [3, 5];
    if (req.maxSeats < min || req.maxSeats > max) {
      throw new ApiError(422, 'invalid_seats', `A ${req.format} game has ${min}–${max} seats`);
    }
    const meta: GameMeta = {
      ...req,
      id: this.deps.newId(),
      status: 'open',
      players: [],
      createdBy: user.sub,
      createdAt: this.now().toISOString(),
      seq: 0,
      engineVersion: ENGINE_VERSION,
    };
    await this.deps.store.createGame(meta);
    return summary(meta);
  }

  async list(identity: Identity, filter: LobbyStatus | 'mine'): Promise<GameSummary[]> {
    const metas =
      filter === 'mine'
        ? await this.deps.store.listUserGames(requireUser(identity).sub)
        : await this.deps.store.listGames(filter);
    return metas.map(summary);
  }

  async join(identity: Identity, id: string, req: JoinGameRequest): Promise<GameSummary> {
    const user = requireUser(identity);
    const meta = await this.meta(id);
    let deck: DeckCards;
    let deckRef: { id: string; version: number } | undefined;
    if ('deckId' in req) {
      if (!this.deps.decks)
        throw new ApiError(422, 'invalid_deck', 'Saved decks are not available');
      const version = req.version ?? (await this.deps.decks.get(identity, req.deckId)).version;
      deck = await this.deps.decks.cardsFor(identity, req.deckId, version);
      deckRef = { id: req.deckId, version };
    } else {
      deck = req.deck;
    }
    await this.validateDeck(deck, meta.format);
    const ok = await this.deps.store.addPlayer(id, {
      user: user.sub,
      name: user.name,
      deck,
      ...(deckRef ? { deckRef } : {}),
    });
    if (!ok) {
      if (meta.status !== 'open')
        throw new ApiError(409, 'not_open', 'The game has already started');
      if (meta.players.some((p) => p.user === user.sub)) {
        throw new ApiError(409, 'already_joined', 'You have already joined this game');
      }
      throw new ApiError(409, 'full', 'The game is full');
    }
    const game = summary(await this.meta(id));
    await this.deps.publisher.publish(id, () => ({ type: 'lobby', game }));
    return game;
  }

  /** The creator starts the game once enough players have joined; seating is random. */
  async start(identity: Identity, id: string): Promise<GameSummary> {
    const user = requireUser(identity);
    const meta = await this.meta(id);
    if (meta.createdBy !== user.sub && !user.groups.includes('admin')) {
      throw new ApiError(403, 'forbidden', 'Only the game creator can start it');
    }
    if (meta.status !== 'open') throw new ApiError(409, 'not_open', 'The game has already started');
    const min = meta.format === 'duel' ? 2 : 3;
    if (meta.players.length < min) {
      throw new ApiError(409, 'not_enough_players', `At least ${min} players are needed`);
    }
    const seating = shuffled(meta.players, this.deps.rng);
    const result = decide(
      newGame(id),
      {
        type: 'StartGame',
        gameId: id,
        format: meta.format,
        seats: seating.map((p, i) => ({
          id: String(i + 1),
          user: p.user,
          ...expand(p.deck ?? { crypt: [], library: [] }),
        })),
      },
      {
        actor: { kind: 'system' },
        now: this.now().toISOString(),
        rng: this.deps.rng,
        catalog: (await this.deps.content()).catalog,
      },
    );
    if (!result.ok) throw new ApiError(422, result.rejection.code, result.rejection.message);
    const steps = run(newGame(id), result.events);
    const after = steps.at(-1)?.after ?? newGame(id);
    const appended = await this.deps.store.append({
      id,
      expectedSeq: 0,
      events: result.events,
      commandId: `start-${id}`,
      user: user.sub,
      snapshot: after,
      meta: { status: 'active', players: meta.players.map(({ deck: _, ...p }) => p) },
      listed: meta.visibility === 'public',
    });
    if (appended !== 'ok') throw new ApiError(409, 'not_open', 'The game has already started');
    this.remember(after);
    const game = summary(await this.meta(id));
    await this.publishSteps(id, steps);
    await this.deps.publisher.publish(id, () => ({ type: 'lobby', game }));
    return game;
  }

  async details(identity: Identity, id: string): Promise<GameDetails> {
    const meta = await this.meta(id);
    const state = meta.status === 'open' ? undefined : await this.load(id, meta.seq);
    this.assertCanView(identity, meta, state);
    const game = summary(meta);
    if (!state) return { game };
    const viewer = viewerOf(identity, state);
    const details: GameDetails = { game, view: project(state, viewer) };
    if (viewer.kind === 'player') details.seat = viewer.seat;
    return details;
  }

  /** Whether the identity may watch the game (public games: anyone, GAME-16). */
  async canView(identity: Identity, id: string): Promise<{ seq: number }> {
    const meta = await this.meta(id);
    const state = meta.status === 'open' ? undefined : await this.load(id, meta.seq);
    this.assertCanView(identity, meta, state);
    return { seq: meta.seq };
  }

  async events(identity: Identity, id: string, after: number): Promise<EventsResponse> {
    const meta = await this.meta(id);
    if (meta.status === 'open') return { seq: 0, events: [], more: false };
    const current = await this.load(id, meta.seq);
    this.assertCanView(identity, meta, current);
    const from = Math.max(0, after);
    const base = await this.stateAt(id, from);
    const events = await this.deps.store.events(id, from, EVENTS_PAGE);
    const viewer = viewerOf(identity, current);
    return {
      seq: current.seq,
      events: run(base, events).map((s) => projectEvent(s.before, s.after, s.ev, viewer)),
      more: events.length === EVENTS_PAGE,
    };
  }

  /** Run one command: validate, decide, append atomically, push to watchers (§5.2). */
  async command(identity: Identity, id: string, req: CommandRequest): Promise<CommandResponse> {
    const user = requireUser(identity);
    for (let attempt = 1; ; attempt++) {
      const done = await this.deps.store.getCommand(id, req.commandId);
      if (done) {
        if (done.user !== user.sub)
          throw new ApiError(409, 'duplicate_command', 'Command ID already used');
        return this.replay(identity, id, done.firstSeq, done.lastSeq);
      }
      const meta = await this.meta(id);
      if (meta.status !== 'active')
        throw new ApiError(409, 'not_active', 'The game is not in progress');
      const state = await this.load(id, meta.seq);
      if (req.expectedSeq !== undefined && req.expectedSeq !== state.seq) {
        throw new ApiError(409, 'stale', `The game is at ${state.seq}; catch up and retry`);
      }
      const actor = actorFor(user, state, req.command.type);
      const result = decide(state, req.command, {
        actor,
        now: this.now().toISOString(),
        rng: this.deps.rng,
        catalog: (await this.deps.content()).catalog,
      });
      if (!result.ok) throw new ApiError(422, result.rejection.code, result.rejection.message);
      const steps = run(state, result.events);
      const after = steps.at(-1)?.after ?? state;
      const crosses =
        Math.floor(after.seq / SNAPSHOT_EVERY) > Math.floor(state.seq / SNAPSHOT_EVERY);
      const appended = await this.deps.store.append({
        id,
        expectedSeq: state.seq,
        events: result.events,
        commandId: req.commandId,
        user: user.sub,
        ...(crosses ? { snapshot: after } : {}),
      });
      if (appended === 'ok') {
        this.remember(after);
        await this.publishSteps(id, steps);
        const viewer = viewerOf(identity, after);
        return {
          seq: after.seq,
          events: steps.map((s) => projectEvent(s.before, s.after, s.ev, viewer)),
        };
      }
      // Someone else's command landed first (or this one did, from a retry): reload and re-decide.
      this.cache.delete(id);
      if (req.expectedSeq !== undefined && appended === 'conflict') {
        throw new ApiError(409, 'stale', 'The game has moved on; catch up and retry');
      }
      if (attempt >= MAX_ATTEMPTS) throw new ApiError(409, 'busy', 'The game is busy; try again');
    }
  }

  private async replay(identity: Identity, id: string, firstSeq: number, lastSeq: number) {
    const base = await this.stateAt(id, firstSeq - 1);
    const events = await this.deps.store.events(id, firstSeq - 1, lastSeq - firstSeq + 1);
    const steps = run(base, events);
    const viewer = viewerOf(identity, steps.at(-1)?.after ?? base);
    return {
      seq: lastSeq,
      events: steps.map((s) => projectEvent(s.before, s.after, s.ev, viewer)),
    };
  }

  private async publishSteps(id: string, steps: Step[]): Promise<void> {
    const after = steps.at(-1)?.after;
    if (!after) return;
    await this.deps.publisher.publish(id, (identity) => {
      const viewer = viewerOf(identity, after);
      return {
        type: 'events',
        gameId: id,
        events: steps.map((s) => projectEvent(s.before, s.after, s.ev, viewer)),
      };
    });
  }

  private async meta(id: string): Promise<GameMeta> {
    const meta = await this.deps.store.getMeta(id);
    if (!meta) throw new ApiError(404, 'not_found', 'No such game');
    return meta;
  }

  /** Current state: cached state plus newer events, or the latest snapshot plus events. */
  private async load(id: string, seq: number): Promise<GameState> {
    const cached = this.cache.get(id);
    if (cached && cached.seq === seq) return cached;
    const base =
      cached && cached.seq < seq ? cached : ((await this.deps.store.snapshot(id)) ?? newGame(id));
    const state = (await this.deps.store.events(id, base.seq)).reduce(evolve, base);
    this.remember(state);
    return state;
  }

  /** The state just after event `seq`, for catch-up and replay. */
  private async stateAt(id: string, seq: number): Promise<GameState> {
    const base = (await this.deps.store.snapshot(id, seq)) ?? newGame(id);
    if (base.seq === seq) return base;
    return (await this.deps.store.events(id, base.seq, seq - base.seq)).reduce(evolve, base);
  }

  private remember(state: GameState) {
    this.cache.delete(state.id);
    this.cache.set(state.id, state);
    if (this.cache.size > CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  private assertCanView(identity: Identity, meta: GameMeta, state: GameState | undefined) {
    if (meta.visibility === 'public') return;
    if (identity.kind === 'user') {
      const { sub, groups } = identity;
      const member =
        meta.players.some((p) => p.user === sub) ||
        state?.seats.some((s) => s.occupants.some((o) => o.user === sub));
      if (member || groups.includes('judge') || groups.includes('admin')) return;
    }
    throw new ApiError(404, 'not_found', 'No such game');
  }

  /** Decks must be legal in the game's format (DECK-04). */
  private async validateDeck(deck: DeckCards, format: GameMeta['format']) {
    const { index } = await this.deps.content();
    const errors = validateDeck(deck, index, format).filter((e) => e.level === 'error');
    if (errors.length) {
      throw new ApiError(422, 'illegal_deck', errors.map((e) => e.message).join('; '));
    }
  }
}

function requireUser(identity: Identity): User {
  if (identity.kind !== 'user') throw new ApiError(401, 'sign_in', 'Sign in first');
  return identity;
}

function run(state: GameState, events: GameEvent[]): Step[] {
  const steps: Step[] = [];
  for (const ev of events) {
    const after = evolve(state, ev);
    steps.push({ before: state, ev, after });
    state = after;
  }
  return steps;
}

/** Seated users view as their seat, judges as judges, everyone else as spectators. */
export function viewerOf(identity: Identity, state: GameState): Viewer {
  if (identity.kind !== 'user') return { kind: 'spectator' };
  return viewerFor(state, identity.sub, { judge: identity.groups.includes('judge') });
}

/** Admins replace players; seated users act as their seat; judges act as judges. */
function actorFor(user: User, state: GameState, type: CommandRequest['command']['type']): Actor {
  if (type === 'ReplacePlayer') {
    if (!user.groups.includes('admin'))
      throw new ApiError(403, 'forbidden', 'Only admins can replace players');
    return { kind: 'admin', user: user.sub };
  }
  if (state.seats.some((s) => s.occupant === user.sub)) return { kind: 'player', user: user.sub };
  if (user.groups.includes('judge')) return { kind: 'judge', user: user.sub };
  throw new ApiError(403, 'not_playing', 'You are not playing in this game');
}

function summary(meta: GameMeta): GameSummary {
  return {
    id: meta.id,
    name: meta.name,
    format: meta.format,
    visibility: meta.visibility,
    status: meta.status,
    maxSeats: meta.maxSeats,
    players: meta.players.map((p) => ({ user: p.user, name: p.name })),
    createdBy: meta.createdBy,
    createdAt: meta.createdAt,
    seq: meta.seq,
  };
}
