/**
 * Client-side game state (architecture §6). Builds the player's view by replaying their projected
 * events through the engine's `evolve` and re-projecting, the same path the property tests check
 * against the server's projection. Live events arrive over the WebSocket; any `seq` gap is filled
 * from `GET /games/{id}/events`.
 *
 * The player's own commands show at once: while one is on its way, its predicted events
 * (predict.ts) are laid over the confirmed view, and the server's events replace them when they
 * arrive, by the command's response or its push, whichever comes first.
 */
import {
  type CardCatalog,
  describeEvent,
  evolve,
  type GameEvent,
  type GameState,
  newGame,
  project,
  type Viewer,
  viewerFor,
} from '@torn-signpost/engine';
import type {
  ChatMessage,
  CommandResponse,
  EventsResponse,
  GameDetails,
  GameSummary,
  PlayerCommand,
  ServerMessage,
} from '@torn-signpost/protocol';
import type { Api } from '../api.ts';
import type { User } from '../auth.tsx';
import { predict } from './predict.ts';

export interface LogLine {
  seq: number;
  at: string;
  text: string;
  /** The first line of a turn, shown as a divider in the log. */
  turn?: boolean;
  /**
   * A change by an amount (a pool, VP or a counter): the same change made again and again in a
   * row reads as one line with the total (mergeRuns). `key` names what changed and who changed it.
   */
  change?: { key: string; delta: number; before: string; after: string };
}

const CHANGES = new Set<GameEvent['type']>(['PoolAdjusted', 'VpAdjusted', 'CounterAdjusted']);

export const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `${n}` : '±0');

/** The log line for an event described as `text`. */
export function logLine(ev: GameEvent, text: string): LogLine {
  const line: LogLine = { seq: ev.seq, at: ev.at, text, ...(startsTurn(ev) ? { turn: true } : {}) };
  if (!CHANGES.has(ev.type) || !('delta' in ev)) return line;
  // The amount is the last signed number in the text: "Bob: Bob's pool -1", "… +2 blood".
  const amount = signed(ev.delta);
  const i = text.lastIndexOf(amount);
  if (i < 0) return line;
  const before = text.slice(0, i);
  const after = text.slice(i + amount.length);
  return { ...line, change: { key: `${before}#${after}`, delta: ev.delta, before, after } };
}

/**
 * Runs of the same change, one after another, as one line with the total: "Bob: Bob's pool -25"
 * rather than 25 lines of -1. Anything else in between (a chat message, another change) ends
 * the run.
 */
export function mergeRuns<T extends { text: string; change?: LogLine['change'] }>(
  entries: readonly T[],
): T[] {
  const out: T[] = [];
  for (const e of entries) {
    const last = out.at(-1);
    if (e.change && last?.change && last.change.key === e.change.key) {
      const delta = last.change.delta + e.change.delta;
      out[out.length - 1] = {
        ...last,
        text: `${e.change.before}${signed(delta)}${e.change.after}`,
        change: { ...last.change, delta },
      };
    } else out.push(e);
  }
  return out;
}

export interface GameSnapshot {
  status: 'loading' | 'live' | 'reconnecting' | 'error';
  error?: string;
  game?: GameSummary;
  viewer: Viewer;
  /** The viewer's seat, when they occupy one. */
  seat?: string;
  view: GameState;
  log: LogLine[];
  chat: ChatMessage[];
  /** Signed-in users watching without a seat (TEMPO-06); unknown until the server says. */
  spectators?: number;
}

/**
 * What the table, toolbar, log and console need from a game: a live game on the server
 * (`GameClient`) or a local replay (`ReplayClient`).
 */
export interface TableClient {
  subscribe(listener: () => void): () => void;
  getSnapshot(): GameSnapshot;
  /** Rejects with an `ApiError` (or another `Error`) when the command is refused. */
  send(command: PlayerCommand): Promise<void>;
  say(text: string): Promise<void>;
  seatName(seat: string): string;
}

export interface GameClientOptions {
  gameId: string;
  api: Api;
  wsUrl: string;
  token: () => Promise<string | undefined>;
  catalog: CardCatalog;
  user?: User;
  /** Wraps a state change, e.g. in a view transition, so moves animate (UX-08). */
  animate?: (apply: () => void) => void;
}

const BACKOFF = [500, 1000, 2000, 5000, 10000];

type Confirmed = Pick<GameSnapshot, 'view' | 'viewer' | 'log'>;

/** A command on its way to the server, and its predicted events (for the view at `seq`). */
interface Pending {
  command: PlayerCommand;
  seq: number;
  events: GameEvent[] | undefined;
}

export class GameClient implements TableClient {
  private snapshot: GameSnapshot;
  private readonly listeners = new Set<() => void>();
  private socket?: WebSocket;
  /**
   * Bumped by every start() and stop(), so a connection belongs to one run. React may start, stop
   * and restart the same client (StrictMode, remounts); stale sockets then ignore themselves.
   */
  private generation = 0;
  private attempts = 0;
  private catchingUp: Promise<void> | undefined;
  /** Asked to catch up again while a catch-up was under way. */
  private catchUpAgain = false;
  /** The view as the server has confirmed it; the snapshot adds the pending predictions. */
  private confirmed: Confirmed;
  /** Commands sent and not yet answered, in the order sent. */
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly opts: GameClientOptions) {
    this.snapshot = {
      status: 'loading',
      viewer: { kind: 'spectator' },
      view: newGame(opts.gameId),
      log: [],
      chat: [],
    };
    this.confirmed = this.snapshot;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  async start(): Promise<void> {
    const generation = ++this.generation;
    try {
      await this.refreshDetails();
      if (this.snapshot.game?.status !== 'open') await this.catchUp();
      const chat = await this.opts
        .api<ChatMessage[]>(`/games/${this.opts.gameId}/chat`)
        .catch(() => []);
      if (generation !== this.generation) return;
      this.update({ chat, status: 'live' });
      void this.connect(generation);
    } catch (e) {
      this.update({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  stop(): void {
    this.generation++;
    this.socket?.close();
  }

  /**
   * Send a command. Its predicted events show straight away, when it can be predicted; the
   * server's projected response replaces them, or, if it's refused, the view goes back.
   */
  async send(command: PlayerCommand): Promise<void> {
    const commandId = crypto.randomUUID();
    this.pending.set(commandId, { command, seq: -1, events: undefined });
    this.show(false);
    let res: CommandResponse;
    try {
      res = await this.opts.api<CommandResponse>(`/games/${this.opts.gameId}/commands`, {
        method: 'POST',
        body: { commandId, command },
      });
    } catch (e) {
      if (this.pending.delete(commandId)) this.show(false);
      throw e;
    }
    this.pending.delete(commandId);
    if (!this.apply(res.events, false)) this.show(false);
  }

  async say(text: string): Promise<void> {
    const message = await this.opts.api<ChatMessage>(`/games/${this.opts.gameId}/chat`, {
      method: 'POST',
      body: { text },
    });
    this.addChat(message);
  }

  /** Lobby actions re-read the game afterwards (and start following it once it begins). */
  async lobby(action: 'join' | 'leave' | 'start', body?: unknown): Promise<void> {
    await this.opts.api(`/games/${this.opts.gameId}/${action}`, { method: 'POST', body });
    await this.refreshDetails();
    if (this.snapshot.game?.status === 'active') await this.catchUp();
  }

  seatName = (seat: string): string => this.nameIn(this.snapshot.view, seat);

  /** A seat's player name as of `state` (the seat may not exist yet in older states). */
  private nameIn(state: GameState, seat: string): string {
    const occupant = state.seats.find((s) => s.id === seat)?.occupant;
    const player = this.snapshot.game?.players.find((p) => p.user === occupant);
    return player?.name ?? occupant ?? seat;
  }

  private async refreshDetails() {
    const details = await this.opts.api<GameDetails>(`/games/${this.opts.gameId}`);
    this.update({ game: details.game });
  }

  /**
   * Fetch the events after the current view. Asked again while one is under way (a push with a gap
   * arrived meanwhile), it fetches once more when that one lands: the request already in flight
   * may have been answered before the missing events existed, and the last event of a game has
   * no later push to reveal the gap.
   */
  private catchUp(): Promise<void> {
    this.catchUpAgain = true;
    this.catchingUp ??= (async () => {
      try {
        while (this.catchUpAgain) {
          this.catchUpAgain = false;
          for (;;) {
            const page = await this.opts.api<EventsResponse>(
              `/games/${this.opts.gameId}/events?after=${this.confirmed.view.seq}`,
            );
            this.apply(page.events, false);
            if (!page.more || page.events.length === 0) break;
          }
        }
      } finally {
        this.catchingUp = undefined;
      }
    })();
    return this.catchingUp;
  }

  /** Add confirmed events; true if the view moved on (and was shown). */
  private apply(events: GameEvent[], animate: boolean): boolean {
    let { view, viewer } = this.confirmed;
    let gap = false;
    const added: LogLine[] = [];
    for (const ev of events) {
      if (ev.seq <= view.seq) continue;
      if (ev.seq > view.seq + 1) {
        gap = true;
        break;
      }
      ({ view, viewer } = this.step(view, ev, added));
    }
    const moved = view !== this.confirmed.view;
    if (moved) {
      this.confirmed = { view, viewer, log: [...this.confirmed.log, ...added] };
      this.show(animate);
    }
    if (gap) void this.catchUp();
    return moved;
  }

  /** One event on `view`, for the viewer it makes; its log line, if it has one, joins `log`. */
  private step(view: GameState, ev: GameEvent, log: LogLine[]) {
    const next = evolve(view, ev);
    // Names come from the state after the event, so "Game started" can name its players.
    const seatName = (seat: string) => this.nameIn(next, seat);
    const text = describeEvent(ev, view, { catalog: this.opts.catalog, seatName });
    // Bookkeeping events (automatic passes, for one) have nothing to show.
    if (text) log.push(logLine(ev, text));
    const viewer = this.viewerFor(next);
    return { view: project(next, viewer), viewer };
  }

  /**
   * Show the confirmed view with the pending commands' predictions on top, in the order sent. A
   * command that can't be predicted stops the ones after it (they may depend on it).
   */
  private show(animate: boolean) {
    let { view, viewer } = this.confirmed;
    const added: LogLine[] = [];
    const user = this.opts.user;
    for (const p of this.pending.values()) {
      if (!user) break;
      if (p.seq !== view.seq) {
        p.seq = view.seq;
        p.events = predict(view, p.command, {
          user,
          viewer,
          catalog: this.opts.catalog,
          now: new Date(),
        });
      }
      if (!p.events) break;
      for (const ev of p.events) ({ view, viewer } = this.step(view, ev, added));
    }
    const log = added.length ? [...this.confirmed.log, ...added] : this.confirmed.log;
    if (view === this.snapshot.view && log === this.snapshot.log) return;
    const seat = viewer.kind === 'player' ? viewer.seat : undefined;
    const patch: Partial<GameSnapshot> = { view, viewer, log };
    // The state moves on now; only the redraw waits for the animation. A browser runs a view
    // transition's update later, after other work: had the state waited too, a newer push
    // (or catch-up) applied meanwhile would be undone by it, and the table left behind.
    const animated = animate && !!this.opts.animate;
    this.update(seat ? { ...patch, seat } : patch, seat === undefined, !animated);
    if (animated) this.opts.animate?.(() => this.notify());
  }

  private viewerFor(state: GameState): Viewer {
    const user = this.opts.user;
    if (!user) return { kind: 'spectator' };
    return viewerFor(state, user.sub, { judge: user.groups.includes('judge') });
  }

  private addChat(message: ChatMessage) {
    if (this.snapshot.chat.some((m) => m.id === message.id)) return;
    this.update({ chat: [...this.snapshot.chat, message] });
  }

  private async connect(generation: number) {
    const token = await this.opts.token();
    if (generation !== this.generation) return;
    const url = new URL(this.opts.wsUrl);
    if (token) url.searchParams.set('token', token);
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      socket.send(JSON.stringify({ type: 'subscribe', gameId: this.opts.gameId }));
    };
    socket.onmessage = (e) => {
      if (generation !== this.generation) return;
      this.receive(JSON.parse(String(e.data)) as ServerMessage);
    };
    socket.onclose = () => {
      if (generation !== this.generation) return;
      this.update({ status: 'reconnecting' });
      const delay = BACKOFF[Math.min(this.attempts++, BACKOFF.length - 1)];
      setTimeout(() => void this.connect(generation), delay);
    };
  }

  /** A message from the WebSocket. */
  private receive(msg: ServerMessage) {
    switch (msg.type) {
      case 'events':
        // Our own command: its prediction is already on the table, so no animation, and the
        // prediction makes way for what the server decided.
        if (msg.commandId && this.pending.delete(msg.commandId)) {
          if (!this.apply(msg.events, false)) this.show(false);
        } else this.apply(msg.events, true);
        break;
      case 'chat':
        this.addChat(msg.message);
        break;
      case 'lobby': {
        const wasOpen = this.snapshot.game?.status === 'open';
        this.update({ game: msg.game });
        if (wasOpen && msg.game.status === 'active') void this.catchUp();
        break;
      }
      case 'audience':
        this.update({ spectators: msg.spectators });
        break;
      case 'subscribed':
        this.update({ status: 'live' });
        if (msg.seq > this.confirmed.view.seq) void this.catchUp();
        break;
      default:
        break;
    }
  }

  private update(patch: Partial<GameSnapshot>, clearSeat = false, notify = true) {
    const next = { ...this.snapshot, ...patch };
    if (clearSeat) delete next.seat;
    this.snapshot = next;
    if (notify) this.notify();
  }

  private notify() {
    for (const l of this.listeners) l();
  }
}

/** A new turn: its unlock phase begins. */
export function startsTurn(ev: GameEvent): boolean {
  return ev.type === 'PhaseAdvanced' && ev.turn.phase === 'unlock';
}
