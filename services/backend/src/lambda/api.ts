import { handle } from 'hono/aws-lambda';
import { createApp } from '../app.ts';

const app = createApp({
  stage: process.env.STAGE ?? 'local',
  version: process.env.APP_VERSION ?? 'dev',
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
});

export const handler = handle(app);
