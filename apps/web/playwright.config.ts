import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (docs/testing.md): the real web app, API and WebSocket server against
 * DynamoDB Local, with the invented test cards. Ports differ from `pnpm dev`, and the table is
 * separate, so a running dev setup is left alone.
 */
const CONTENT = 'http://localhost:3102';
const API = 'http://localhost:3101';
const WEB = 'http://localhost:5174';
const reuse = !process.env.CI;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node e2e/content-server.mjs',
      url: `${CONTENT}/data/manifest.json`,
      env: { PORT: '3102' },
      reuseExistingServer: reuse,
    },
    {
      command: 'pnpm exec tsx src/local/init-db.ts && pnpm exec tsx src/local/server.ts',
      cwd: '../../services/backend',
      url: `${API}/health`,
      env: {
        PORT: '3101',
        TABLE_NAME: 'ts-e2e',
        CONTENT_URL: CONTENT,
        WEB_ORIGIN: WEB,
      },
      reuseExistingServer: reuse,
    },
    {
      // The built app, as deployed; CI has built it already, locally `pnpm build` first.
      command: 'pnpm exec vite preview --port 5174 --strictPort',
      url: WEB,
      env: {
        TS_API_URL: API,
        TS_WS_URL: 'ws://localhost:3101/ws',
        TS_CONTENT_URL: CONTENT,
      },
      reuseExistingServer: reuse,
    },
  ],
});
