/**
 * WebSocket connections and fan-out (architecture §5.4). The same handlers serve the API Gateway
 * WebSocket Lambda and the local development server.
 */
import { ClientMessage, type ServerMessage } from '@torn-signpost/protocol';
import type { Identity } from '../auth.ts';
import type { GameStore } from '../db/store.ts';
import type { EmailService } from '../email/service.ts';
import { ApiError } from '../errors.ts';
import type { GameService, Publisher } from '../games/service.ts';
import type { NotificationService } from '../notifications/service.ts';
import { presenceKey, type Timers } from '../timers/timers.ts';
import type { ConnectionGateway } from './gateway.ts';

/** How long a player may be gone before they count as away (TEMPO-06): rides out a page reload. */
export const ABSENCE_DELAY_MS = 30_000;

/** Push is best effort: clients catch up over HTTP when they see a `seq` gap (§5.2). */
export class Fanout implements Publisher {
  constructor(
    private readonly store: GameStore,
    private readonly gateway: ConnectionGateway,
  ) {}

  async publish(gameId: string, build: (identity: Identity) => ServerMessage | undefined) {
    const subscribers = await this.store.subscribers(gameId);
    await Promise.all(
      subscribers.map(async ({ connectionId, identity }) => {
        const message = build(identity);
        if (!message) return;
        try {
          if (!(await this.gateway.post(connectionId, message))) {
            await this.store.deleteConnection(connectionId);
          }
        } catch (e) {
          console.warn('push failed', { gameId, connectionId, error: String(e) });
        }
      }),
    );
  }
}

export interface RealtimeOptions {
  /** Track presence and the audience (TEMPO-06); off unless set. */
  presence?: boolean;
  /** Absence checks (TEMPO-06); without them players are never marked away. */
  timers?: Timers;
  /** Remembers judges as they connect, so judge calls reach them. */
  notifications?: Pick<NotificationService, 'seen' | 'openedGame'>;
  /** Records that the user is using the site, so email waits while they are. */
  email?: Pick<EmailService, 'active'>;
  now?: () => Date;
}

export class Realtime {
  private readonly fanout: Fanout;
  private readonly now: () => Date;

  constructor(
    private readonly store: GameStore,
    private readonly gateway: ConnectionGateway,
    private readonly games: GameService,
    private readonly options: RealtimeOptions = {},
  ) {
    this.fanout = new Fanout(store, gateway);
    this.now = options.now ?? (() => new Date());
  }

  async connect(connectionId: string, identity: Identity): Promise<void> {
    await this.store.putConnection(connectionId, identity);
    await this.options.notifications?.seen(identity);
  }

  async disconnect(connectionId: string): Promise<void> {
    const conn = await this.store.getConnection(connectionId);
    await this.store.deleteConnection(connectionId);
    if (!conn) return;
    for (const gameId of new Set(conn.games)) await this.left(conn.identity, gameId);
  }

  /**
   * Arrival is recorded at once; absence only after `ABSENCE_DELAY_MS`, and only if the player
   * hasn't come back (`GameService.checkAbsence`). Presence never gets in the way of watching.
   */
  private async arrived(identity: Identity, gameId: string): Promise<void> {
    if (!this.options.presence) return;
    try {
      if (identity.kind === 'user') await this.games.setPresence(gameId, identity.sub, true);
      await this.publishAudience(gameId);
    } catch (e) {
      console.warn('presence failed', { gameId, error: String(e) });
    }
  }

  private async left(identity: Identity, gameId: string): Promise<void> {
    if (!this.options.presence) return;
    try {
      if (identity.kind === 'user' && (await this.games.isPlaying(gameId, identity.sub))) {
        await this.options.timers?.schedule(
          presenceKey(gameId, identity.sub),
          new Date(this.now().getTime() + ABSENCE_DELAY_MS),
          { kind: 'presence', gameId, user: identity.sub },
        );
      }
      await this.publishAudience(gameId);
    } catch (e) {
      console.warn('presence failed', { gameId, error: String(e) });
    }
  }

  /** Tell everyone watching how many spectators there are: signed-in users without a seat. */
  private async publishAudience(gameId: string): Promise<void> {
    const subs = await this.store.subscribers(gameId);
    const seated = await this.games.seatedUsers(gameId);
    const watchers = new Set(
      subs.map(({ connectionId, identity }) =>
        identity.kind === 'user' ? identity.sub : `guest:${connectionId}`,
      ),
    );
    const spectators = [...watchers].filter((u) => !seated.has(u)).length;
    await this.fanout.publish(gameId, () => ({ type: 'audience', gameId, spectators }));
  }

  async message(connectionId: string, body: string): Promise<void> {
    const reply = (m: ServerMessage) => this.gateway.post(connectionId, m);
    let parsed: ClientMessage;
    try {
      parsed = ClientMessage.parse(JSON.parse(body));
    } catch {
      await reply({ type: 'error', message: 'Unrecognised message' });
      return;
    }
    switch (parsed.type) {
      case 'ping':
        await reply({ type: 'pong' });
        return;
      case 'active': {
        const conn = await this.store.getConnection(connectionId);
        if (conn) await this.options.email?.active(conn.identity);
        return;
      }
      case 'unsubscribe': {
        await this.store.unsubscribe(connectionId, parsed.gameId);
        const conn = await this.store.getConnection(connectionId);
        if (conn) await this.left(conn.identity, parsed.gameId);
        return;
      }
      case 'subscribe': {
        const conn = await this.store.getConnection(connectionId);
        if (!conn) {
          await reply({ type: 'error', message: 'Connection expired; reconnect' });
          return;
        }
        try {
          const { seq } = await this.games.canView(conn.identity, parsed.gameId);
          await this.store.subscribe(connectionId, parsed.gameId, conn.identity);
          await reply({ type: 'subscribed', gameId: parsed.gameId, seq });
          // Read first, so by the time the player shows as present nothing about it is unread.
          await this.options.notifications?.openedGame(conn.identity, parsed.gameId);
          await this.arrived(conn.identity, parsed.gameId);
          await this.options.email?.active(conn.identity);
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          await reply({ type: 'error', message: e.message });
        }
      }
    }
  }
}
