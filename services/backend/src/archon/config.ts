/**
 * Archon settings: its address, our redirect URI, and the client id and secret, which live in
 * Secrets Manager as `{"clientId", "clientSecret"}` (stored by hand: docs/m7-plan.md). Read once
 * per cold start, on first use.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { ArchonConfig } from '@torn-signpost/archon';

export function archonConfig(opts: {
  baseUrl: string;
  redirectUri: string;
  /** The client's id and secret given directly (the fake Archon in tests)… */
  client?: { id: string; secret: string };
  /** …or the Secrets Manager secret holding them. */
  secretId?: string;
}): () => Promise<ArchonConfig> {
  let loaded: Promise<ArchonConfig> | undefined;
  return () => {
    loaded ??= (async () => {
      const client = opts.client ?? (await fromSecret(opts.secretId ?? ''));
      return {
        baseUrl: opts.baseUrl.replace(/\/$/, ''),
        redirectUri: opts.redirectUri,
        clientId: client.id,
        clientSecret: client.secret,
      };
    })();
    loaded.catch(() => {
      loaded = undefined;
    });
    return loaded;
  };
}

async function fromSecret(secretId: string): Promise<{ id: string; secret: string }> {
  if (!secretId) throw new Error('No Archon client secret configured');
  const r = await new SecretsManagerClient({ region: 'us-east-1' }).send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  const value = JSON.parse(r.SecretString ?? '{}') as { clientId?: string; clientSecret?: string };
  if (!value.clientId || !value.clientSecret)
    throw new Error('The Archon client secret is incomplete');
  return { id: value.clientId, secret: value.clientSecret };
}
