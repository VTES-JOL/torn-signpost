import { randomBytes } from 'node:crypto';
import { type Content, cdnContent } from './content/catalog.ts';
import { documentClient } from './db/client.ts';
import { DeckStore } from './db/decks.ts';
import { NotificationStore } from './db/notifications.ts';
import { ProfileStore } from './db/profiles.ts';
import { GameStore } from './db/store.ts';
import { DeckService } from './decks/service.ts';
import { cryptoRng } from './games/rng.ts';
import { GameService } from './games/service.ts';
import { NotificationService } from './notifications/service.ts';
import type { ConnectionGateway } from './realtime/gateway.ts';
import { Fanout, Realtime } from './realtime/realtime.ts';
import type { TimerHandler, TimerPayload, Timers } from './timers/timers.ts';
import { ProfileService } from './users/service.ts';

export interface Services {
  store: GameStore;
  games: GameService;
  decks: DeckService;
  profiles: ProfileService;
  notifications: NotificationService;
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
  /** One-off timers; given the handler their firings go to. None: presence is never marked away. */
  timers?: (handler: () => TimerHandler) => Timers;
  /** Track presence (TEMPO-06); off by default. */
  presence?: boolean;
}): Services {
  const db = documentClient(
    opts.endpoint
      ? { tableName: opts.tableName, endpoint: opts.endpoint }
      : { tableName: opts.tableName },
  );
  const store = new GameStore(db, opts.tableName);
  const content = opts.content ?? cdnContent(opts.contentUrl);
  const decks = new DeckService({ store: new DeckStore(db, opts.tableName), content, newId });
  const timers = opts.timers?.(() => (payload) => fireTimer(services, payload));
  const notifications = new NotificationService({
    store: new NotificationStore(db, opts.tableName),
    games: store,
    gateway: opts.gateway,
    newId,
  });
  const games = new GameService({
    store,
    content,
    decks,
    rng: cryptoRng,
    publisher: new Fanout(store, opts.gateway),
    newId,
    presence: !!opts.presence,
    notifier: notifications,
    ...(timers ? { timers } : {}),
  });
  const profiles = new ProfileService({ store: new ProfileStore(db, opts.tableName) });
  const realtime = new Realtime(store, opts.gateway, games, {
    notifications,
    presence: !!opts.presence,
    ...(timers ? { timers } : {}),
  });
  const services: Services = { store, games, decks, profiles, notifications, realtime };
  return services;
}

/** A timer fired (locally, or through the timers Lambda): do what it was set for. */
export async function fireTimer(services: Services, payload: TimerPayload): Promise<void> {
  switch (payload.kind) {
    case 'presence':
      await services.games.checkAbsence(payload.gameId, payload.user);
      return;
    case 'game':
      await services.games.runTimer(payload.gameId, payload.command);
      return;
  }
}
