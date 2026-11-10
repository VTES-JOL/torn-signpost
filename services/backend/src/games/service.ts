/**
 * The game service (architecture §5.2): lobby, start, and the per-game serialised command
 * pipeline. Every response and push is projected for its recipient (§4.5).
 */
import { expand, validateDeck } from '@torn-signpost/cards';
import {
  type Actor,
  type Command,
  decide,
  timers as dueTimers,
  ENGINE_VERSION,
  evolve,
  type GameEvent,
  type GameState,
  HOUR_MS,
  MINUTE_MS,
  newGame,
  project,
  projectEvent,
  type Rng,
  shuffled,
  type Timer,
  type Viewer,
  viewerFor,
  waitingOn,
} from '@torn-signpost/engine';
import type {
  ChatMessage,
  ChatRequest,
  CommandRequest,
  CommandResponse,
  CreateGameRequest,
  DeckCards,
  Escalation,
  EventsResponse,
  GameDetails,
  GameSummary,
  JoinGameRequest,
  JudgeQueueEntry,
  LobbyStatus,
  ResolveEscalationRequest,
  ServerMessage,
} from '@torn-signpost/protocol';
import type { Identity } from '../auth.ts';
import type { Content } from '../content/catalog.ts';
import type { GameMeta, GameStore } from '../db/store.ts';
import type { DeckService } from '../decks/service.ts';
import { ApiError } from '../errors.ts';
import type { Notifier } from '../notifications/service.ts';
import { ending } from '../stats/result.ts';
import type { GameTimerCommand, Timers } from '../timers/timers.ts';

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
  /** Waits between retries after a conflict; tests can make it instant. */
  sleep?: (ms: number) => Promise<void>;
  /** Track presence (TEMPO-06); off unless set. Deadlines depend on it. */
  presence?: boolean;
  /** Schedules the checks the engine asks for: deadlines, the time limit, the end of a pause. */
  timers?: Timers;
  /** In-app notifications (NOTIF-01); none in some tests. */
  notifier?: Notifier;
  /** Results and stats of counted games (STATS-01..03); none in some tests. */
  results?: {
    gameEnded(meta: GameMeta, state: GameState): Promise<void>;
    joined(user: string, gameId: string): Promise<void>;
  };
}

const SNAPSHOT_EVERY = 25;
/**
 * Tries at appending a command before giving up as busy. Writers that collide wait a short random,
 * growing time before trying again, so they don't keep colliding in step.
 */
const MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 15;
/** Full jitter: a random wait up to 15, 30, 60… ms. */
const retryDelay = (attempt: number) => Math.random() * RETRY_BASE_MS * 2 ** (attempt - 1);
const CACHE_SIZE = 200;
const EVENTS_PAGE = 200;
/** Finished public games the lobby lists (M6.6, F4). */
const RECENT_RESULTS = 20;

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
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: GameServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
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
        : await this.deps.store.listGames(filter, filter === 'finished' ? RECENT_RESULTS : 50);
    if (filter !== 'mine') return metas.map(summary);
    // Your own games say whether they're waiting on you, so the lobby can put those first.
    const user = requireUser(identity).sub;
    return Promise.all(
      metas.map(async (meta) => {
        const game = summary(meta);
        if (meta.status !== 'active') return game;
        const state = await this.load(meta.id, meta.seq);
        const seat = liveSeatOf(state, user);
        if (seat && waitingOn(state).some((w) => w.seat === seat.id)) game.waitingOnYou = true;
        return game;
      }),
    );
  }

  /**
   * A finished game's result (M6.6): anyone's for a counted game, even a private one (S1, F2);
   * otherwise only for those who can view the game.
   */
  async result(identity: Identity, id: string): Promise<GameSummary> {
    const meta = await this.meta(id);
    if (meta.status !== 'finished') throw new ApiError(404, 'not_finished', 'The game is not over');
    const state = await this.load(id, meta.seq);
    const end = meta.ended ?? ending(meta, state);
    if (!end?.counted) this.assertCanView(identity, meta, state);
    return summary({ ...meta, ...(end ? { ended: end } : {}) });
  }

  /** The meta changes as a game finishes: its status, its ending, its lobby list. */
  private finishing(meta: GameMeta, after: GameState) {
    const end = ending(meta, after);
    return {
      meta: { status: 'finished' as const, ...(end ? { ended: end } : {}) },
      listed: meta.visibility === 'public',
    };
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
        settings: {
          ...(meta.timeLimitMinutes ? { timeLimitMs: meta.timeLimitMinutes * MINUTE_MS } : {}),
          ...(meta.deadlineHours ? { deadlineMs: meta.deadlineHours * HOUR_MS } : {}),
        },
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
    await this.syncTimers(id, newGame(id), after);
    await this.deps.notifier?.afterCommand({
      game: meta,
      before: newGame(id),
      after,
      events: result.events,
      actor: user.sub,
    });
    const game = summary(await this.meta(id));
    await this.publishSteps(id, steps);
    await this.deps.publisher.publish(id, () => ({ type: 'lobby', game }));
    // Players already watching the lobby are at the table from the first moment.
    if (this.deps.presence) {
      for (const u of await this.watchingUsers(id)) await this.setPresence(id, u, true);
    }
    return game;
  }

  /**
   * Presence (TEMPO-06): record that a seated user has the game open, or is away. Does nothing
   * for anyone not in a live seat, for games not in progress, or when it is already recorded.
   */
  async setPresence(id: string, user: string, present: boolean): Promise<void> {
    if (!this.deps.presence) return;
    await this.system(id, (state) => {
      const seat = liveSeatOf(state, user);
      if (!seat || !!seat.present === present) return undefined;
      return { type: 'SetPresence', seat: seat.id, present };
    });
  }

  /** A timer the engine asked for fired: run its check, which does nothing if it's stale. */
  async runTimer(id: string, command: GameTimerCommand): Promise<void> {
    await this.system(id, () => command);
  }

  /**
   * Create, move or cancel this game's timers to match what the engine now asks for. A failure is
   * logged, not thrown: the command has already happened.
   */
  private async syncTimers(id: string, before: GameState, after: GameState): Promise<void> {
    const timers = this.deps.timers;
    if (!timers) return;
    const opts = { deadlines: !!this.deps.presence };
    const plan = (s: GameState) =>
      new Map<string, Timer>(dueTimers(s, opts).map((t) => [t.key, t]));
    const was = plan(before);
    const now = plan(after);
    try {
      for (const [key, t] of now) {
        if (was.get(key)?.at === t.at) continue;
        await timers.schedule(gameTimerKey(id, key), new Date(t.at), {
          kind: 'game',
          gameId: id,
          command: t.command,
        });
      }
      for (const key of was.keys()) if (!now.has(key)) await timers.cancel(gameTimerKey(id, key));
    } catch (e) {
      console.error('timer sync failed', { id, error: String(e) });
    }
  }

  /** Every open judge call, oldest first: judges only (GAME-18). */
  async judgeQueue(identity: Identity): Promise<JudgeQueueEntry[]> {
    const user = requireUser(identity);
    if (!user.groups.includes('judge')) throw new ApiError(403, 'forbidden', 'Judges only');
    return this.deps.store.judgeQueue();
  }

  /** Keep the judge queue in step with the game's open calls. Logged, not thrown, on failure. */
  private async syncJudgeQueue(meta: GameMeta, before: GameState, after: GameState) {
    const was = new Map((before.judgeCalls ?? []).map((c) => [c.id, c]));
    const now = new Map((after.judgeCalls ?? []).map((c) => [c.id, c]));
    try {
      for (const [id, call] of now) {
        if (was.get(id)?.claimedBy === call.claimedBy && was.has(id)) continue;
        await this.deps.store.putJudgeCall({
          gameId: meta.id,
          gameName: meta.name,
          tournament: after.settings.tournament,
          call,
        });
      }
      for (const [id, call] of was) {
        if (!now.has(id)) await this.deps.store.deleteJudgeCall(meta.id, call);
      }
    } catch (e) {
      console.error('judge queue sync failed', { id: meta.id, error: String(e) });
    }
  }

  /**
   * Results (STATS-01): a game that just ended is recorded if it counts; a player brought in by a
   * replacement joins the game's players (their games list).
   */
  private async afterEnd(
    meta: GameMeta,
    before: GameState,
    after: GameState,
    events: readonly GameEvent[],
  ): Promise<void> {
    const results = this.deps.results;
    if (!results) return;
    try {
      for (const ev of events) {
        if (ev.type === 'PlayerReplaced') await results.joined(ev.user, meta.id);
      }
    } catch (e) {
      console.error('adding a replacement to the game failed', { id: meta.id, error: String(e) });
    }
    if (ended(before, after)) await results.gameEnded(meta, after);
  }

  /** A judge referred a call to the admins: it waits in the admin queue (GAME-19). */
  private async syncEscalations(meta: GameMeta, before: GameState, events: readonly GameEvent[]) {
    try {
      for (const ev of events) {
        if (ev.type !== 'JudgeCallResolved' || ev.ruling.kind !== 'escalate') continue;
        const call = before.judgeCalls?.find((c) => c.id === ev.id);
        if (!call) continue;
        await this.deps.store.putEscalation({
          gameId: meta.id,
          gameName: meta.name,
          call,
          judge: ev.by.kind === 'judge' ? ev.by.user : '',
          ...(ev.note ? { note: ev.note } : {}),
          at: ev.at,
        });
      }
    } catch (e) {
      console.error('admin queue sync failed', { id: meta.id, error: String(e) });
    }
  }

  /** Every escalation waiting for an admin, oldest first: admins only. */
  async escalations(identity: Identity): Promise<Escalation[]> {
    requireAdmin(identity);
    return this.deps.store.escalations();
  }

  /**
   * An admin deals with an escalation: replaces the seat's player with `user` (found by name by
   * the caller), or dismisses it. Either way it leaves the queue.
   */
  async resolveEscalation(
    identity: Identity,
    gameId: string,
    callId: string,
    req: ResolveEscalationRequest,
    userByName: (name: string) => Promise<string | undefined>,
  ): Promise<void> {
    requireAdmin(identity);
    const entry = (await this.deps.store.escalations()).find(
      (e) => e.gameId === gameId && e.call.id === callId,
    );
    if (!entry) throw new ApiError(404, 'not_found', 'No such escalation');
    if ('replace' in req) {
      const user = await userByName(req.replace.name);
      if (!user) throw new ApiError(404, 'not_found', `Nobody is called “${req.replace.name}”`);
      await this.command(identity, gameId, {
        commandId: `replace-${callId}-${this.deps.newId()}`.slice(0, 64),
        command: { type: 'ReplacePlayer', seat: req.replace.seat, user },
      });
    }
    await this.deps.store.deleteEscalation(entry);
  }

  /**
   * Bring a player's presence in line with whether they're watching: after their last connection
   * closed a while ago (away, unless they came back), or after recording their arrival failed.
   */
  async checkPresence(id: string, user: string): Promise<void> {
    await this.setPresence(id, user, (await this.watchingUsers(id)).has(user));
  }

  /** Whether `user` holds a live seat in a game in progress, so their presence matters. */
  async isPlaying(id: string, user: string): Promise<boolean> {
    const meta = await this.deps.store.getMeta(id);
    if (meta?.status !== 'active') return false;
    return !!liveSeatOf(await this.load(id, meta.seq), user);
  }

  /** Everyone who has a seat (or, before the start, has joined): they aren't the audience. */
  async seatedUsers(id: string): Promise<Set<string>> {
    const meta = await this.deps.store.getMeta(id);
    if (!meta) return new Set();
    if (meta.status === 'open') return new Set(meta.players.map((p) => p.user));
    const state = await this.load(id, meta.seq);
    return new Set(state.seats.map((s) => s.occupant));
  }

  private async watchingUsers(id: string): Promise<Set<string>> {
    const subs = await this.deps.store.subscribers(id);
    return new Set(subs.flatMap((s) => (s.identity.kind === 'user' ? [s.identity.sub] : [])));
  }

  /**
   * Run a system command built from the current state, through the same append and push as player
   * commands. `build` returning nothing, or the engine refusing, means there is nothing to record.
   */
  private async system(
    id: string,
    build: (state: GameState) => Command | undefined,
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const meta = await this.deps.store.getMeta(id, true);
      if (meta?.status !== 'active') return;
      const state = await this.load(id, meta.seq, true);
      const command = build(state);
      if (!command) return;
      const result = decide(state, command, {
        actor: { kind: 'system' },
        now: this.now().toISOString(),
        rng: this.deps.rng,
        catalog: (await this.deps.content()).catalog,
      });
      if (!result.ok) return;
      const steps = run(state, result.events);
      const after = steps.at(-1)?.after ?? state;
      const appended = await this.deps.store.append({
        id,
        expectedSeq: state.seq,
        events: result.events,
        commandId: `system-${this.deps.newId()}`,
        user: 'system',
        ...(crossesSnapshot(state, after) || ended(state, after) ? { snapshot: after } : {}),
        ...(ended(state, after) ? this.finishing(meta, after) : {}),
      });
      if (appended === 'ok') {
        this.remember(after);
        await this.syncTimers(id, state, after);
        await this.syncJudgeQueue(meta, state, after);
        await this.syncEscalations(meta, state, result.events);
        await this.afterEnd(meta, state, after, result.events);
        await this.publishSteps(id, steps);
        await this.deps.notifier?.afterCommand({
          game: meta,
          before: state,
          after,
          events: result.events,
        });
        return;
      }
      this.cache.delete(id);
      if (attempt >= MAX_ATTEMPTS) throw new ApiError(409, 'busy', 'The game is busy; try again');
      await this.sleep(retryDelay(attempt));
    }
  }

  async leave(identity: Identity, id: string): Promise<GameSummary> {
    const user = requireUser(identity);
    const meta = await this.meta(id);
    if (meta.status !== 'open') throw new ApiError(409, 'not_open', 'The game has already started');
    if (!meta.players.some((p) => p.user === user.sub)) {
      throw new ApiError(409, 'not_joined', 'You have not joined this game');
    }
    if (!(await this.deps.store.removePlayer(meta, user.sub))) {
      throw new ApiError(409, 'busy', 'The game changed; try again');
    }
    const game = summary(await this.meta(id));
    await this.deps.publisher.publish(id, () => ({ type: 'lobby', game }));
    return game;
  }

  /** Players and judges talk; spectators only read (GAME-16). */
  async chat(identity: Identity, id: string, req: ChatRequest): Promise<ChatMessage> {
    const user = requireUser(identity);
    const meta = await this.meta(id);
    const state = meta.status === 'open' ? undefined : await this.load(id, meta.seq);
    const seated = state
      ? state.seats.some((s) => s.occupant === user.sub)
      : meta.players.some((p) => p.user === user.sub);
    if (!seated && !user.groups.includes('judge')) {
      throw new ApiError(403, 'spectator', 'Spectators cannot chat');
    }
    const message: ChatMessage = {
      id: this.deps.newId(),
      user: user.sub,
      name: user.name,
      text: req.text,
      at: this.now().toISOString(),
      seq: meta.seq,
    };
    await this.deps.store.putChat(id, message);
    await this.deps.publisher.publish(id, () => ({ type: 'chat', gameId: id, message }));
    await this.deps.notifier?.chat({
      game: meta,
      text: req.text,
      author: user.sub,
      authorName: user.name,
      people: meta.players,
    });
    return message;
  }

  async chatHistory(identity: Identity, id: string): Promise<ChatMessage[]> {
    await this.canView(identity, id);
    return this.deps.store.chat(id);
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

  /** The game's latest seq, read consistently. */
  async seq(id: string): Promise<number> {
    return (await this.meta(id, true)).seq;
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
      const meta = await this.meta(id, true);
      if (meta.status !== 'active')
        throw new ApiError(409, 'not_active', 'The game is not in progress');
      const state = await this.load(id, meta.seq, true);
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
      const crosses = crossesSnapshot(state, after);
      const appended = await this.deps.store.append({
        id,
        expectedSeq: state.seq,
        events: result.events,
        commandId: req.commandId,
        user: user.sub,
        ...(crosses || ended(state, after) ? { snapshot: after } : {}),
        // A finished game moves to the lobby's finished list (GAME-09), newest ended first.
        ...(ended(state, after) ? this.finishing(meta, after) : {}),
      });
      if (appended === 'ok') {
        this.remember(after);
        await this.syncTimers(id, state, after);
        await this.syncJudgeQueue(meta, state, after);
        await this.syncEscalations(meta, state, result.events);
        await this.afterEnd(meta, state, after, result.events);
        await this.publishSteps(id, steps);
        await this.deps.notifier?.afterCommand({
          game: meta,
          before: state,
          after,
          events: result.events,
          actor: user.sub,
        });
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
      await this.sleep(retryDelay(attempt));
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

  private async meta(id: string, consistent = false): Promise<GameMeta> {
    const meta = await this.deps.store.getMeta(id, consistent);
    if (!meta) throw new ApiError(404, 'not_found', 'No such game');
    return meta;
  }

  /** Current state: cached state plus newer events, or the latest snapshot plus events. */
  private async load(id: string, seq: number, consistent = false): Promise<GameState> {
    const cached = this.cache.get(id);
    if (cached && cached.seq === seq) return cached;
    const base =
      cached && cached.seq < seq ? cached : ((await this.deps.store.snapshot(id)) ?? newGame(id));
    const state = (await this.deps.store.events(id, base.seq, undefined, consistent)).reduce(
      evolve,
      base,
    );
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

const gameTimerKey = (gameId: string, key: string) => `game:${gameId}:${key}`;

function crossesSnapshot(before: GameState, after: GameState): boolean {
  return Math.floor(after.seq / SNAPSHOT_EVERY) > Math.floor(before.seq / SNAPSHOT_EVERY);
}

function liveSeatOf(state: GameState, user: string) {
  return state.seats.find((s) => s.occupant === user && !s.ousted && !s.withdrawn);
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
/** The command ended the game (GAME-09). */
const ended = (before: GameState, after: GameState) =>
  before.status === 'active' && after.status === 'finished';

function requireAdmin(identity: Identity): User {
  const user = requireUser(identity);
  if (!user.groups.includes('admin')) throw new ApiError(403, 'forbidden', 'Admins only');
  return user;
}

function actorFor(user: User, state: GameState, type: CommandRequest['command']['type']): Actor {
  if (type === 'ReplacePlayer' || type === 'EndGame') {
    if (!user.groups.includes('admin'))
      throw new ApiError(
        403,
        'forbidden',
        type === 'EndGame' ? 'Only admins can end games' : 'Only admins can replace players',
      );
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
    ...(meta.timeLimitMinutes ? { timeLimitMinutes: meta.timeLimitMinutes } : {}),
    ...(meta.deadlineHours ? { deadlineHours: meta.deadlineHours } : {}),
    players: meta.players.map((p) => ({ user: p.user, name: p.name })),
    createdBy: meta.createdBy,
    createdAt: meta.createdAt,
    seq: meta.seq,
    ...(meta.ended ? { ended: meta.ended } : {}),
  };
}
