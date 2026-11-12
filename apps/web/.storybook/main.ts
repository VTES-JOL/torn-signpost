import type { StorybookConfig } from '@storybook/react-vite';

/**
 * Storybook for the web app's components (`pnpm --filter @torn-signpost/web storybook`). It
 * reuses vite.config.ts. Card data and images are WoD material, never bundled (LEGAL-08): the
 * stories fetch them from the content CDN through `/content`, proxied here so the CDN's CORS rules
 * don't matter. TS_CONTENT_URL points it at another content origin.
 */
const contentUrl = process.env.TS_CONTENT_URL ?? 'https://content.tornsignpost.org';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.tsx'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true },
  viteFinal: (vite) => ({
    ...vite,
    server: {
      ...vite.server,
      proxy: {
        ...vite.server?.proxy,
        '/content': {
          target: contentUrl,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/content/, ''),
        },
      },
    },
  }),
};

export default config;
