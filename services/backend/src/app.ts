import { ENGINE_VERSION } from '@torn-signpost/engine';
import type { HealthResponse } from '@torn-signpost/protocol';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

export interface AppConfig {
  stage: string;
  version: string;
  allowedOrigins: string[];
}

/** The HTTP API (architecture §5.1). Routes are added per milestone. */
export function createApp(config: AppConfig): Hono {
  const app = new Hono();

  app.use('*', cors({ origin: config.allowedOrigins, maxAge: 600 }));

  app.get('/health', (c) => {
    const body: HealthResponse = {
      status: 'ok',
      service: 'torn-signpost-api',
      version: config.version,
      engineVersion: ENGINE_VERSION,
      stage: config.stage,
      time: new Date().toISOString(),
    };
    return c.json(body);
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  return app;
}
