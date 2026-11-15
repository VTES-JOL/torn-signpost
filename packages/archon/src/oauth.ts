/**
 * Archon's OAuth 2.0 (authorization code with PKCE). The person opens `/consent` (Archon's login
 * first, if needed), approves, and is sent back to our redirect URI with `code` and `state`; the
 * backend exchanges the code with the client secret. Scopes: `profile:read` (who the member is)
 * and `event:run` (act for the organiser on the one tournament the grant names).
 */
import { createHash, randomBytes } from 'node:crypto';
import { ArchonError } from './errors.ts';
import type { TokenClaims, Tokens, UserInfo } from './types.ts';

export interface ArchonConfig {
  /** e.g. https://archon.krcg.org (test) or https://archon.vekn.net. */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Injected in tests (a fake Archon); the global fetch otherwise. */
  fetch?: typeof fetch;
}

export type Scope = 'profile:read' | 'event:run';

/** A PKCE pair: keep the verifier server-side, send the challenge. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Where to send the person to approve. `tournament` names the one an `event:run` grant is for. */
export function consentUrl(
  config: ArchonConfig,
  opts: { scope: Scope; state: string; challenge: string; tournament?: string },
): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: opts.scope,
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    ...(opts.tournament ? { tournament: opts.tournament } : {}),
  });
  return `${config.baseUrl}/consent?${q}`;
}

/** The client's id and secret go in the form body: Archon refuses HTTP Basic. */
async function token(config: ArchonConfig, params: Record<string, string>): Promise<Tokens> {
  const res = await call(config, '/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...params,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });
  return (await res.json()) as Tokens;
}

export function exchangeCode(config: ArchonConfig, code: string, verifier: string) {
  return token(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });
}

/** Archon rotates refresh tokens: store the new one, the old one no longer works. */
export function refresh(config: ArchonConfig, refreshToken: string) {
  return token(config, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

export async function userInfo(config: ArchonConfig, accessToken: string): Promise<UserInfo> {
  const res = await call(config, '/oauth/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const body = (await res.json()) as Partial<UserInfo>;
  if (!body.sub) throw new ArchonError(502, 'archon.bad_userinfo', 'Archon named no member');
  return { sub: body.sub, vekn_id: body.vekn_id || null, roles: body.roles ?? [] };
}

/**
 * The claims of an access token, read without checking its signature: it came straight from
 * Archon's token endpoint, and Archon checks it whenever it's used. Empty if it isn't a JWT.
 */
export function tokenClaims(accessToken: string): TokenClaims {
  const payload = accessToken.split('.')[1];
  if (!payload) return {};
  try {
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    return {
      ...(typeof c.sub === 'string' ? { sub: c.sub } : {}),
      ...(typeof c.scope === 'string' ? { scope: c.scope } : {}),
      ...(typeof c.tournament === 'string' ? { tournament: c.tournament } : {}),
      ...(typeof c.exp === 'number' ? { exp: c.exp } : {}),
    };
  } catch {
    return {};
  }
}

/** A request to Archon: its refusals as `ArchonError`, a network failure as status 0. */
export async function call(config: ArchonConfig, path: string, init: RequestInit = {}) {
  let res: Response;
  try {
    res = await (config.fetch ?? fetch)(`${config.baseUrl}${path}`, init);
  } catch (e) {
    throw new ArchonError(0, 'archon.unreachable', `Archon is unreachable: ${String(e)}`);
  }
  if (!res.ok) throw await ArchonError.from(res);
  return res;
}
