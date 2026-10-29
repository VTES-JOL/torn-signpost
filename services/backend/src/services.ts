import { randomBytes } from 'node:crypto';
import { type Content, cdnContent } from './content/catalog.ts';
import { documentClient } from './db/client.ts';
import { DeckStore } from './db/decks.ts';
import { GameStore } from './db/store.ts';
import { DeckService } from './decks/service.ts';
import { cryptoRng } from './games/rng.ts';
import { GameService } from './games/service.ts';
import type { ConnectionGateway } from './realtime/gateway.ts';
import { Fanout, Realtime } from './realtime/realtime.ts';

export interface Services {
  store: GameStore;
  games: GameService;
  decks: DeckService;
  realtime: Realtime;
}

/** Short, unguessable IDs (private games and decks are reachable only by ID). */
export function newId(): string {
  return randomBytes(9).toString('base64url');
}

export function createServices(opts: {
  tableName: string;
  endpoint?: string;
  contentUrl: string;
  gateway: ConnectionGateway;
  /** Override the card source (tests). */
  content?: Content;
}): Services {
  const db = documentClient(
    opts.endpoint
      ? { tableName: opts.tableName, endpoint: opts.endpoint }
      : { tableName: opts.tableName },
  );
  const store = new GameStore(db, opts.tableName);
  const content = opts.content ?? cdnContent(opts.contentUrl);
  const decks = new DeckService({ store: new DeckStore(db, opts.tableName), content, newId });
  const games = new GameService({
    store,
    content,
    decks,
    rng: cryptoRng,
    publisher: new Fanout(store, opts.gateway),
    newId,
  });
  return { store, games, decks, realtime: new Realtime(store, opts.gateway, games) };
}
