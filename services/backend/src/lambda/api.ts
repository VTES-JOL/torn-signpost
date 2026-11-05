import { handle } from 'hono/aws-lambda';
import { createApp } from '../app.ts';
import { allowedOrigins, auth, gamesEnabled, servicesFor, stage, version } from './env.ts';

const services = servicesFor(process.env.WS_CALLBACK_URL ?? '');

const app = createApp({
  stage,
  version,
  allowedOrigins,
  auth,
  decks: services.decks,
  profiles: services.profiles,
  notifications: services.notifications,
  ...(services.email ? { email: services.email } : {}),
  ...(gamesEnabled ? { games: services.games } : {}),
});

export const handler = handle(app);
