import { ClientConfig } from '@torn-signpost/protocol';

/** Loads the deploy-time runtime config (/config.json), so one build serves any stage. */
export async function loadConfig(): Promise<ClientConfig> {
  const res = await fetch('/config.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`config.json: HTTP ${res.status}`);
  return ClientConfig.parse(await res.json());
}
