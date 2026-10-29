/** Lambda configuration from environment variables set by the CDK API stack. */
import { cognitoAuthenticator } from '../auth.ts';
import { awsGateway } from '../realtime/gateway.ts';
import { createServices, type Services } from '../services.ts';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
};

export const stage = process.env.STAGE ?? 'local';
export const version = process.env.APP_VERSION ?? 'dev';
export const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);
export const gamesEnabled = process.env.GAMES_ENABLED === 'true';

export const auth = cognitoAuthenticator(env('USER_POOL_ID'), env('USER_POOL_CLIENT_ID'));

const byCallbackUrl = new Map<string, Services>();

/** Services that push through the WebSocket API at `callbackUrl` (reused across warm invocations). */
export function servicesFor(callbackUrl: string): Services {
  let services = byCallbackUrl.get(callbackUrl);
  if (!services) {
    services = createServices({
      tableName: env('TABLE_NAME'),
      contentUrl: env('CONTENT_URL'),
      gateway: awsGateway(callbackUrl),
    });
    byCallbackUrl.set(callbackUrl, services);
  }
  return services;
}
