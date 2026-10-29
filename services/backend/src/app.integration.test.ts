import { seededRng } from '@torn-signpost/engine';
import type { CommandResponse, GameDetails, GameSummary } from '@torn-signpost/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { devAuthenticator } from './auth.ts';
import { defaultCatalog } from './games/catalog.ts';
import { GameService } from './games/service.ts';
import { dynamoAvailable, testStore } from './testing/dynamo.ts';

const available = await dynamoAvailable();

describe.skipIf(!available)('games over HTTP (DynamoDB Local)', () => {
  let cleanup: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    const t = await testStore();
    cleanup = t.cleanup;
    const games = new GameService({
      store: t.store,
      catalog: defaultCatalog,
      rng: seededRng(3),
      publisher: { publish: async () => {} },
      newId: () => 'http-game',
    });
    app = createApp({
      stage: 'test',
      version: '1',
      allowedOrigins: [],
      auth: devAuthenticator,
      games,
    });
  });
  afterAll(() => cleanup?.());

  const call = async (method: string, path: string, user?: string, body?: unknown) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (user) headers.Authorization = `Bearer dev:${user}`;
    const res = await app.request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as unknown };
  };

  it('plays through create → join → start → command → catch-up', async () => {
    const deck = { crypt: Array(12).fill('t-tomas'), library: Array(40).fill('t-ward') };
    expect((await call('POST', '/games', undefined, {})).status).toBe(401);
    expect((await call('POST', '/games', 'alice', { name: '' })).status).toBe(400);
    const created = await call('POST', '/games', 'alice', {
      name: 'HTTP table',
      format: 'standard',
      visibility: 'public',
      maxSeats: 3,
    });
    expect(created.status).toBe(201);
    const id = (created.json as GameSummary).id;
    for (const u of ['alice', 'bob', 'carol']) {
      expect((await call('POST', `/games/${id}/join`, u, { deck })).status).toBe(200);
    }
    expect((await call('POST', `/games/${id}/start`, 'alice')).status).toBe(200);

    const mine = (await call('GET', `/games/${id}`, 'bob')).json as GameDetails;
    expect(mine.seat).toBeDefined();
    const bad = await call('POST', `/games/${id}/commands`, 'bob', {
      commandId: 'abcdefgh',
      command: { type: 'Draw', count: 'lots' },
    });
    expect(bad.status).toBe(400);
    const res = await call('POST', `/games/${id}/commands`, 'bob', {
      commandId: 'draw-0001',
      command: { type: 'Draw', count: 7 },
    });
    expect(res.status).toBe(200);
    expect((res.json as CommandResponse).seq).toBe(2);
    const rejected = await call('POST', `/games/${id}/commands`, 'bob', {
      commandId: 'draw-0002',
      command: { type: 'Draw', count: 50 },
    });
    expect(rejected).toMatchObject({ status: 422, json: { error: 'not-enough' } });

    const caughtUp = await call('GET', `/games/${id}/events?after=1`);
    expect(caughtUp).toMatchObject({ status: 200, json: { seq: 2, more: false } });
    expect(JSON.stringify(caughtUp.json)).not.toContain('t-ward');
    expect((await call('GET', '/games?status=active')).json).toEqual([
      expect.objectContaining({ id, status: 'active' }),
    ]);
  });
});
