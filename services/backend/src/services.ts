import { randomBytes } from 'node:crypto';
import { documentClient } from './db/client.ts';
import { GameStore } from './db/store.ts';
import { defaultCatalog } from './games/catalog.ts';
import { cryptoRng } from './games/rng.ts';
import { GameService } from './games/service.ts';
import type { ConnectionGateway } from './realtime/gateway.ts';
import { Fanout, Realtime } from './realtime/realtime.ts';

export interface Services {
  store: GameStore;
  games: GameService;
  realtime: Realtime;
}

/** Short, unguessable game IDs (private games are reachable only by ID). */
export function gameId(): string {
  return randomBytes(9).toString('base64url');
}

export function createServices(opts: {
  tableName: string;
  endpoint?: string;
  gateway: ConnectionGateway;
}): Services {
  const store = new GameStore(
    documentClient(
      opts.endpoint
        ? { tableName: opts.tableName, endpoint: opts.endpoint }
        : { tableName: opts.tableName },
    ),
    opts.tableName,
  );
  const games = new GameService({
    store,
    catalog: defaultCatalog,
    rng: cryptoRng,
    publisher: new Fanout(store, opts.gateway),
    newId: gameId,
  });
  return { store, games, realtime: new Realtime(store, opts.gateway, games) };
}
