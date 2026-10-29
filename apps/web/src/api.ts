import type { ApiError as ApiErrorBody } from '@torn-signpost/protocol';
import { useMemo } from 'react';
import { useAuth } from './auth.tsx';
import { useConfig } from './content.tsx';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Api = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

/** Calls the API with the signed-in user's token; errors become `ApiError`s. */
export function useApi(): Api {
  const { apiUrl } = useConfig();
  const auth = useAuth();
  return useMemo<Api>(
    () =>
      async <T>(path: string, init: { method?: string; body?: unknown } = {}) => {
        const token = await auth.token();
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        if (init.body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(`${apiUrl}${path}`, {
          method: init.method ?? 'GET',
          headers,
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
        if (res.status === 204) return undefined as T;
        const body = (await res.json().catch(() => ({}))) as T | ApiErrorBody;
        if (!res.ok) {
          const err = body as Partial<ApiErrorBody>;
          throw new ApiError(res.status, err.error ?? 'error', err.message ?? `HTTP ${res.status}`);
        }
        return body as T;
      },
    [apiUrl, auth],
  );
}
