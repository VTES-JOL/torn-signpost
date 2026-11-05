import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { type Connect, defineConfig, type Plugin } from 'vite';

/**
 * In `vite dev` and `vite preview`, serve /config.json pointing at the local API (or TS_API_URL,
 * e.g. the beta API). End-to-end tests run against `vite preview` of the build. Deployed builds get
 * their config.json from the CDK web-deploy stack instead.
 */
function localConfig(): Plugin {
  const serve = (server: { middlewares: Connect.Server }) => {
    const example = JSON.parse(
      readFileSync(new URL('public/config.example.json', import.meta.url), 'utf8'),
    );
    const config = {
      ...example,
      stage: 'local',
      apiUrl: process.env.TS_API_URL ?? 'http://localhost:3001',
      wsUrl: process.env.TS_WS_URL ?? 'ws://localhost:3001/ws',
      ...(process.env.TS_CONTENT_URL ? { contentUrl: process.env.TS_CONTENT_URL } : {}),
      // Features still dark on the beta are on locally.
      flags: { ...example.flags, replay: true, presence: true, clock: true, judgeCalls: true },
    };
    server.middlewares.use('/config.json', (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(config));
    });
  };
  return {
    name: 'torn-signpost-local-config',
    configureServer: serve,
    configurePreviewServer: serve,
  };
}

export default defineConfig({
  plugins: [react(), localConfig()],
  build: { sourcemap: true },
});
