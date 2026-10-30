import { z } from 'zod';

/** Feature flags keep unfinished features dark on the live beta (architecture §9). */
export const FeatureFlags = z.record(z.string(), z.boolean());
export type FeatureFlags = z.infer<typeof FeatureFlags>;

export const HealthResponse = z.object({
  status: z.literal('ok'),
  service: z.literal('torn-signpost-api'),
  version: z.string(),
  engineVersion: z.string(),
  stage: z.string(),
  time: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** Runtime configuration served to the web client as /config.json (written at deploy time). */
export const ClientConfig = z.object({
  stage: z.string(),
  apiUrl: z.url(),
  /** WebSocket endpoint for live game updates (architecture §5.4). */
  wsUrl: z.url(),
  /** Content pack origin (WoD material, LEGAL-08). */
  contentUrl: z.url(),
  auth: z.object({
    domain: z.string(),
    userPoolId: z.string(),
    clientId: z.string(),
  }),
  flags: FeatureFlags,
});
export type ClientConfig = z.infer<typeof ClientConfig>;
export * from './decks.ts';
export * from './games.ts';
export * from './users.ts';
