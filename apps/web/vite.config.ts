import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * In `vite dev`, serve /config.json pointing at the local API (or TS_API_URL, e.g. the beta API).
 * Deployed builds get their config.json from the CDK web-deploy stack instead.
 */
function localConfig(): Plugin {
  return {
    name: 'torn-signpost-local-config',
    apply: 'serve',
    configureServer(server) {
      const example = JSON.parse(
        readFileSync(new URL('public/config.example.json', import.meta.url), 'utf8'),
      );
      const config = {
        ...example,
        stage: 'local',
        apiUrl: process.env.TS_API_URL ?? 'http://localhost:3001',
      };
      server.middlewares.use('/config.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(config));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localConfig()],
  build: { sourcemap: true },
});
