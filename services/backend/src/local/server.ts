/** Runs the HTTP API as a local Node server (`pnpm dev`); the same Hono app runs in Lambda. */
import { serve } from '@hono/node-server';
import { createApp } from '../app.ts';
import { local } from './env.ts';

process.env.TABLE_NAME = local.tableName;

const app = createApp({ stage: 'local', version: 'dev', allowedOrigins: [local.webOrigin] });

serve({ fetch: app.fetch, port: local.port }, ({ port }) => {
  console.log(`API listening on http://localhost:${port} (table ${local.tableName})`);
});
