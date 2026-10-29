/**
 * Sign-in (AUTH-01/02): Cognito managed login with the authorization code flow and PKCE. Locally
 * (stage `local`) the API accepts `dev:<name>` tokens instead, so no Cognito round trip is needed.
 */
import type { ClientConfig } from '@torn-signpost/protocol';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

export interface User {
  sub: string;
  name: string;
  groups: string[];
}

interface Tokens {
  idToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface Auth {
  user?: User;
  /** A current ID token for the API, refreshed if needed; undefined when signed out. */
  token(): Promise<string | undefined>;
  /** Cognito: redirect to managed login. Local: sign in as `devName`. */
  signIn(devName?: string): Promise<void>;
  signOut(): void;
  /** Exchange the code on /auth/callback; returns where to go next. */
  completeSignIn(params: URLSearchParams): Promise<string>;
  isLocal: boolean;
}

const STORAGE_KEY = 'ts.auth';
const PKCE_KEY = 'ts.pkce';
const AuthContext = createContext<Auth | undefined>(undefined);

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth outside AuthProvider');
  return auth;
}

function load(): Tokens | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Tokens) : undefined;
  } catch {
    return undefined;
  }
}

function store(tokens: Tokens | undefined) {
  try {
    if (tokens) localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode: stay signed in for this page only.
  }
}

export function userFromToken(token: string): User | undefined {
  if (token.startsWith('dev:')) {
    const [, name = '', groups] = token.split(':');
    return { sub: name, name, groups: groups ? groups.split(',') : [] };
  }
  try {
    const payload = JSON.parse(
      atob((token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')),
    );
    const email = typeof payload.email === 'string' ? payload.email.split('@')[0] : undefined;
    return {
      sub: payload.sub,
      name: payload.name ?? email ?? 'Player',
      groups: payload['cognito:groups'] ?? [],
    };
  } catch {
    return undefined;
  }
}

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export function AuthProvider({ config, children }: { config: ClientConfig; children: ReactNode }) {
  const [tokens, setTokens] = useState<Tokens | undefined>(load);
  const isLocal = config.stage === 'local';
  const redirectUri = `${location.origin}/auth/callback`;
  const authBase = `https://${config.auth.domain}`;

  const save = useCallback((next: Tokens | undefined) => {
    store(next);
    setTokens(next);
  }, []);

  const tokenRequest = useCallback(
    async (params: Record<string, string>): Promise<Tokens> => {
      const res = await fetch(`${authBase}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.auth.clientId, ...params }),
      });
      if (!res.ok) throw new Error(`Sign-in failed (${res.status})`);
      const body = (await res.json()) as {
        id_token: string;
        refresh_token?: string;
        expires_in: number;
      };
      return {
        idToken: body.id_token,
        expiresAt: Date.now() + body.expires_in * 1000,
        ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
      };
    },
    [authBase, config.auth.clientId],
  );

  const auth = useMemo<Auth>(() => {
    const user = tokens ? userFromToken(tokens.idToken) : undefined;
    return {
      ...(user ? { user } : {}),
      isLocal,
      async token() {
        if (!tokens) return undefined;
        if (isLocal || tokens.expiresAt - Date.now() > 60_000) return tokens.idToken;
        if (!tokens.refreshToken) {
          save(undefined);
          return undefined;
        }
        try {
          const next = await tokenRequest({
            grant_type: 'refresh_token',
            refresh_token: tokens.refreshToken,
          });
          save({ ...next, refreshToken: next.refreshToken ?? tokens.refreshToken });
          return next.idToken;
        } catch {
          save(undefined);
          return undefined;
        }
      },
      async signIn(devName) {
        if (isLocal) {
          const name = (devName ?? '').trim().toLowerCase();
          if (/^[a-z0-9-]{1,32}(:[a-z,]+)?$/.test(name)) {
            save({ idToken: `dev:${name}`, expiresAt: Number.MAX_SAFE_INTEGER });
          }
          return;
        }
        const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
        const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
        const challenge = base64url(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
        );
        sessionStorage.setItem(
          PKCE_KEY,
          JSON.stringify({ verifier, state, back: location.pathname + location.search }),
        );
        const url = new URL(`${authBase}/oauth2/authorize`);
        url.search = new URLSearchParams({
          response_type: 'code',
          client_id: config.auth.clientId,
          redirect_uri: redirectUri,
          scope: 'openid email profile',
          code_challenge_method: 'S256',
          code_challenge: challenge,
          state,
        }).toString();
        location.assign(url.toString());
      },
      signOut() {
        save(undefined);
        if (!isLocal) {
          const url = new URL(`${authBase}/logout`);
          url.search = new URLSearchParams({
            client_id: config.auth.clientId,
            logout_uri: `${location.origin}/`,
          }).toString();
          location.assign(url.toString());
        }
      },
      async completeSignIn(params) {
        const pending = JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? 'null') as {
          verifier: string;
          state: string;
          back: string;
        } | null;
        sessionStorage.removeItem(PKCE_KEY);
        const code = params.get('code');
        if (!pending || !code || params.get('state') !== pending.state)
          throw new Error('Sign-in expired; try again');
        save(
          await tokenRequest({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            code_verifier: pending.verifier,
          }),
        );
        return pending.back || '/';
      },
    };
  }, [tokens, isLocal, authBase, config.auth.clientId, redirectUri, save, tokenRequest]);

  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}
