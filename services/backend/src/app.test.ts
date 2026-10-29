import { HealthResponse } from '@torn-signpost/protocol';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.ts';

const app = createApp({ stage: 'test', version: '1.2.3', allowedOrigins: ['https://example.org'] });

describe('api', () => {
  it('GET /health matches the protocol schema', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = HealthResponse.parse(await res.json());
    expect(body.stage).toBe('test');
    expect(body.version).toBe('1.2.3');
  });

  it('allows CORS only for configured origins', async () => {
    const ok = await app.request('/health', { headers: { Origin: 'https://example.org' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://example.org');
    const other = await app.request('/health', { headers: { Origin: 'https://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
