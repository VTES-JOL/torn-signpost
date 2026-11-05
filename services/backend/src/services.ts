import { randomBytes } from 'node:crypto';
import { type Content, cdnContent } from './content/catalog.ts';
import { documentClient } from './db/client.ts';
import { DeckStore } from './db/decks.ts';
import { EmailStore } from './db/email.ts';
import { NotificationStore } from './db/notifications.ts';
import { ProfileStore } from './db/profiles.ts';
import { StatsStore } from './db/stats.ts';
import { GameStore } from './db/store.ts';
import { DeckService } from './decks/service.ts';
import type { Mailer } from './email/mailer.ts';
import { EmailService } from './email/service.ts';
import { cryptoRng } from './games/rng.ts';
import { GameService } from './games/service.ts';
import { NotificationService } from './notifications/service.ts';
import type { ConnectionGateway } from './realtime/gateway.ts';
import { Fanout, Realtime } from './realtime/realtime.ts';
import { ResultsService } from './stats/service.ts';
import type { TimerHandler, TimerPayload, Timers } from './timers/timers.ts';
import { ProfileService } from './users/service.ts';

export interface Services {
  store: GameStore;
  games: GameService;
  decks: DeckService;
  profiles: ProfileService;
  notifications: NotificationService;
  results: ResultsService;
  /** Missing while email is switched off for the stage. */
  email?: EmailService;
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
  /** Email notifications (NOTIF-02); off without one. */
  email?: {
    mailer: Mailer;
    secret: () => Promise<string>;
    webUrl: string;
    apiUrl: string;
  };
}): Services {
  const db = documentClient(
    opts.endpoint
      ? { tableName: opts.tableName, endpoint: opts.endpoint }
      : { tableName: opts.tableName },
  );
  const store = new GameStore(db, opts.tableName);
  const content = opts.content ?? cdnContent(opts.contentUrl);
  const deckStore = new DeckStore(db, opts.tableName);
  const decks = new DeckService({ store: deckStore, content, newId });
  const profileStore = new ProfileStore(db, opts.tableName);
  const results = new ResultsService({
    store: new StatsStore(db, opts.tableName),
    games: store,
    profiles: profileStore,
    decks: deckStore,
    content,
  });
  const timers = opts.timers?.(() => (payload) => fireTimer(services, payload));
  const notificationStore = new NotificationStore(db, opts.tableName);
  const email = opts.email
    ? new EmailService({
        ...opts.email,
        store: new EmailStore(db, opts.tableName),
        notifications: notificationStore,
        games: store,
        ...(timers ? { timers } : {}),
      })
    : undefined;
  const notifications = new NotificationService({
    store: notificationStore,
    games: store,
    gateway: opts.gateway,
    newId,
    ...(email ? { email } : {}),
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
    results,
    ...(timers ? { timers } : {}),
  });
  const profiles = new ProfileService({ store: profileStore });
  const realtime = new Realtime(store, opts.gateway, games, {
    notifications,
    ...(email ? { email } : {}),
    presence: !!opts.presence,
    ...(timers ? { timers } : {}),
  });
  const services: Services = {
    store,
    games,
    decks,
    profiles,
    notifications,
    results,
    realtime,
    ...(email ? { email } : {}),
  };
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
    case 'email':
      await services.email?.sendNow(payload.user, payload.id);
      return;
    case 'digest': {
      const result = await services.email?.digest(payload.slot);
      console.log('digest sent', { slot: payload.slot, ...result });
      return;
    }
  }
}
