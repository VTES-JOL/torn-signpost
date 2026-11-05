/** Lambda configuration from environment variables set by the CDK API stack. */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { cognitoAuthenticator } from '../auth.ts';
import { sesMailer } from '../email/mailer.ts';
import { awsGateway } from '../realtime/gateway.ts';
import { createServices, type Services } from '../services.ts';
import { schedulerTimers } from '../timers/timers.ts';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
};

export const stage = process.env.STAGE ?? 'local';
export const version = process.env.APP_VERSION ?? 'dev';
export const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);
export const gamesEnabled = process.env.GAMES_ENABLED === 'true';
export const presenceEnabled = process.env.PRESENCE_ENABLED === 'true';
export const emailEnabled = process.env.EMAIL_ENABLED === 'true';

/** The unsubscribe-link key, read once per cold start. */
let secret: Promise<string> | undefined;
const unsubscribeSecret = () => {
  secret ??= new SecretsManagerClient()
    .send(new GetSecretValueCommand({ SecretId: env('UNSUBSCRIBE_SECRET_ARN') }))
    .then((r) => {
      if (!r.SecretString) throw new Error('Unsubscribe secret is empty');
      return r.SecretString;
    });
  secret.catch(() => {
    secret = undefined;
  });
  return secret;
};

const email = () => ({
  mailer: sesMailer({
    from: env('EMAIL_FROM'),
    configurationSet: env('EMAIL_CONFIGURATION_SET'),
  }),
  secret: unsubscribeSecret,
  webUrl: env('WEB_URL'),
  apiUrl: env('API_URL'),
});

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
      presence: presenceEnabled,
      ...(emailEnabled ? { email: email() } : {}),
      // Firings go to the timers Lambda, not back to this process.
      ...(process.env.SCHEDULER_GROUP
        ? {
            timers: () =>
              schedulerTimers({
                group: env('SCHEDULER_GROUP'),
                targetArn: env('TIMERS_FUNCTION_ARN'),
                roleArn: env('SCHEDULER_ROLE_ARN'),
                ...(process.env.TIMERS_DLQ_ARN
                  ? { deadLetterArn: process.env.TIMERS_DLQ_ARN }
                  : {}),
              }),
          }
        : {}),
    });
    byCallbackUrl.set(callbackUrl, services);
  }
  return services;
}
