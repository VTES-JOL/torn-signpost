/**
 * Client-side game state (architecture §6). Builds the player's view by replaying their projected
 * events through the engine's `evolve` and re-projecting, the same path the property tests check
 * against the server's projection. Live events arrive over the WebSocket; any `seq` gap is filled
 * from `GET /games/{id}/events`.
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

export interface LogLine {
  seq: number;
  at: string;
  text: string;
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

export class GameClient {
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

  constructor(private readonly opts: GameClientOptions) {
    this.snapshot = {
      status: 'loading',
      viewer: { kind: 'spectator' },
      view: newGame(opts.gameId),
      log: [],
      chat: [],
    };
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

  /** Send a command; the server's projected response is applied straight away. */
  async send(command: PlayerCommand): Promise<void> {
    const res = await this.opts.api<CommandResponse>(`/games/${this.opts.gameId}/commands`, {
      method: 'POST',
      body: { commandId: crypto.randomUUID(), command },
    });
    this.apply(res.events, false);
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

  private catchUp(): Promise<void> {
    this.catchingUp ??= (async () => {
      try {
        for (;;) {
          const page = await this.opts.api<EventsResponse>(
            `/games/${this.opts.gameId}/events?after=${this.snapshot.view.seq}`,
          );
          this.apply(page.events, false);
          if (!page.more || page.events.length === 0) break;
        }
      } finally {
        this.catchingUp = undefined;
      }
    })();
    return this.catchingUp;
  }

  private apply(events: GameEvent[], animate: boolean) {
    let { view, viewer, log } = this.snapshot;
    let gap = false;
    const added: LogLine[] = [];
    for (const ev of events) {
      if (ev.seq <= view.seq) continue;
      if (ev.seq > view.seq + 1) {
        gap = true;
        break;
      }
      const next = evolve(view, ev);
      // Names come from the state after the event, so "Game started" can name its players.
      const seatName = (seat: string) => this.nameIn(next, seat);
      const text = describeEvent(ev, view, { catalog: this.opts.catalog, seatName });
      // Bookkeeping events (automatic passes, for one) have nothing to show.
      if (text) added.push({ seq: ev.seq, at: ev.at, text });
      viewer = this.viewerFor(next);
      view = project(next, viewer);
    }
    if (view !== this.snapshot.view) {
      log = [...log, ...added];
      const seat = viewer.kind === 'player' ? viewer.seat : undefined;
      const patch: Partial<GameSnapshot> = { view, viewer, log };
      const change = () => this.update(seat ? { ...patch, seat } : patch, seat === undefined);
      if (animate && this.opts.animate) this.opts.animate(change);
      else change();
    }
    if (gap) void this.catchUp();
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
      const msg = JSON.parse(String(e.data)) as ServerMessage;
      switch (msg.type) {
        case 'events':
          this.apply(msg.events, true);
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
        case 'subscribed':
          this.update({ status: 'live' });
          if (msg.seq > this.snapshot.view.seq) void this.catchUp();
          break;
        default:
          break;
      }
    };
    socket.onclose = () => {
      if (generation !== this.generation) return;
      this.update({ status: 'reconnecting' });
      const delay = BACKOFF[Math.min(this.attempts++, BACKOFF.length - 1)];
      setTimeout(() => void this.connect(generation), delay);
    };
  }

  private update(patch: Partial<GameSnapshot>, clearSeat = false) {
    const next = { ...this.snapshot, ...patch };
    if (clearSeat) delete next.seat;
    this.snapshot = next;
    for (const l of this.listeners) l();
  }
}
