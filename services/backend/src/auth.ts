/**
 * Caller identity (architecture §5.6). The Lambda verifies Cognito ID tokens itself rather than
 * relying on an API Gateway authorizer, so routes open to guests still recognise signed-in users.
 */
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { ApiError } from './errors.ts';

export type Identity =
  | { kind: 'guest' }
  | { kind: 'user'; sub: string; name: string; groups: string[] };

/** Resolves a bearer token (without the `Bearer ` prefix) to an identity. */
export type Authenticator = (token: string | undefined) => Promise<Identity>;

export const GUEST: Identity = { kind: 'guest' };

export function bearer(header: string | undefined | null): string | undefined {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return m?.[1];
}

export function cognitoAuthenticator(userPoolId: string, clientId: string): Authenticator {
  const verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'id' });
  return async (token) => {
    if (!token) return GUEST;
    try {
      const claims = await verifier.verify(token);
      const name =
        typeof claims.name === 'string' ? claims.name : `Player ${claims.sub.slice(0, 4)}`;
      return { kind: 'user', sub: claims.sub, name, groups: claims['cognito:groups'] ?? [] };
    } catch {
      throw new ApiError(401, 'invalid_token', 'Sign in again');
    }
  };
}

/**
 * Local development only: `dev:<user>[:<group>,...]`, e.g. `dev:alice` or `dev:jo:judge,admin`.
 * Never wired up outside the local server and tests.
 */
export const devAuthenticator: Authenticator = async (token) => {
  if (!token) return GUEST;
  const m = /^dev:([a-z0-9-]{1,32})(?::([a-z,]+))?$/i.exec(token);
  if (!m?.[1]) throw new ApiError(401, 'invalid_token', 'Use a dev:<user> token locally');
  const user = m[1].toLowerCase();
  return { kind: 'user', sub: user, name: user, groups: m[2]?.split(',') ?? [] };
};
