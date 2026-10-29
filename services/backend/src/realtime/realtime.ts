/**
 * WebSocket connections and fan-out (architecture §5.4). The same handlers serve the API Gateway
 * WebSocket Lambda and the local development server.
 */
import { ClientMessage, type ServerMessage } from '@torn-signpost/protocol';
import type { Identity } from '../auth.ts';
import type { GameStore } from '../db/store.ts';
import { ApiError } from '../errors.ts';
import type { GameService, Publisher } from '../games/service.ts';
import type { ConnectionGateway } from './gateway.ts';

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

export class Realtime {
  constructor(
    private readonly store: GameStore,
    private readonly gateway: ConnectionGateway,
    private readonly games: GameService,
  ) {}

  connect(connectionId: string, identity: Identity): Promise<void> {
    return this.store.putConnection(connectionId, identity);
  }

  disconnect(connectionId: string): Promise<void> {
    return this.store.deleteConnection(connectionId);
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
      case 'unsubscribe':
        await this.store.unsubscribe(connectionId, parsed.gameId);
        return;
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
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          await reply({ type: 'error', message: e.message });
        }
      }
    }
  }
}
