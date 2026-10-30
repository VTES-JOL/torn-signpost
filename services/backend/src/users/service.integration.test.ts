import { seededRng } from '@torn-signpost/engine';
import type { GameSummary, Profile } from '@torn-signpost/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { devAuthenticator } from '../auth.ts';
import { ProfileStore } from '../db/profiles.ts';
import { GameService } from '../games/service.ts';
import { testContent, testDeck } from '../testing/content.ts';
import { dynamoAvailable, testStore } from '../testing/dynamo.ts';
import { ProfileService } from './service.ts';

const available = await dynamoAvailable();

describe.skipIf(!available)('display names (DynamoDB Local)', () => {
  let cleanup: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  let store: ProfileStore;
  beforeAll(async () => {
    const t = await testStore();
    cleanup = t.cleanup;
    store = new ProfileStore(t.db, t.tableName);
    app = createApp({
      stage: 'test',
      version: '1',
      allowedOrigins: [],
      auth: devAuthenticator,
      profiles: new ProfileService({ store }),
      games: new GameService({
        store: t.store,
        content: testContent,
        rng: seededRng(1),
        publisher: { publish: async () => {} },
        newId: () => 'named-game',
      }),
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
    const json = res.status === 204 ? {} : ((await res.json()) as Record<string, unknown>);
    return { status: res.status, json };
  };

  it('starts with a placeholder name and needs a signed-in user', async () => {
    expect((await call('GET', '/me')).status).toBe(401);
    expect((await call('PUT', '/me', undefined, { name: 'Ghost' })).status).toBe(401);
    const me = await call('GET', '/me', 'alice');
    expect(me.json).toMatchObject({ sub: 'alice', name: 'alice', chosen: false });
  });

  it('claims unique names, ignoring case, once per user', async () => {
    const set = (user: string, name: string) => call('PUT', '/me', user, { name });
    expect((await set('alice', 'Nocturne')).json).toMatchObject({ name: 'Nocturne', chosen: true });
    expect((await call('GET', '/me', 'alice')).json).toMatchObject({ name: 'Nocturne' });
    // Choosing the same name again is harmless; anything else is locked.
    expect((await set('alice', 'Nocturne')).status).toBe(200);
    const locked = await set('alice', 'Methuselah');
    expect(locked.status).toBe(409);
    expect(locked.json.error).toBe('name_locked');

    const clash = await set('bob', 'NOCTURNE');
    expect(clash.status).toBe(409);
    expect(clash.json.error).toBe('name_taken');
  });

  it('lets only admins rename, and never frees the old name', async () => {
    await call('PUT', '/me', 'gina', { name: 'Gina' });
    const rename = (by: string, name: string, to: string) =>
      call('PUT', `/users/${name}/name`, by, { name: to });
    expect((await rename('gina', 'Gina', 'Gina2')).status).toBe(403);
    expect((await rename('root:admin', 'nobody-here', 'X_x')).status).toBe(404);
    expect((await rename('root:admin', 'gina', 'Gina_V')).status).toBe(204);
    expect((await call('GET', '/me', 'gina')).json).toMatchObject({ name: 'Gina_V' });
    // The old name now refers to nobody, and can't be taken by someone else.
    expect((await rename('root:admin', 'Gina', 'Gina3')).status).toBe(404);
    expect((await call('PUT', '/me', 'hank', { name: 'gina' })).status).toBe(409);
    // An admin can give the user their old name back.
    expect((await rename('root:admin', 'Gina_V', 'Gina')).status).toBe(204);
  });

  it('rejects malformed and reserved names', async () => {
    for (const name of ['ab', 'has space', 'x'.repeat(25), 'émile']) {
      expect((await call('PUT', '/me', 'dave', { name })).status).toBe(400);
    }
    expect((await call('PUT', '/me', 'dave', { name: 'Judge' })).status).toBe(409);
  });

  it('uses the chosen name in games', async () => {
    await call('PUT', '/me', 'erin', { name: 'Erin_the_Bold' });
    const created = await call('POST', '/games', 'erin', {
      name: 'Named',
      format: 'standard',
      visibility: 'public',
      maxSeats: 3,
    });
    const id = (created.json as unknown as GameSummary).id;
    const joined = await call('POST', `/games/${id}/join`, 'erin', { deck: testDeck });
    expect((joined.json as unknown as GameSummary).players[0]?.name).toBe('Erin_the_Bold');
  });

  it('reports a concurrent rename as stale rather than losing a claim', async () => {
    await store.rename('frank', 'Frank1', undefined, new Date().toISOString());
    expect(await store.rename('frank', 'Frank2', 'NotMyName', new Date().toISOString())).toBe(
      'stale',
    );
    const profile = (await call('GET', '/me', 'frank')).json as unknown as Profile;
    expect(profile.name).toBe('Frank1');
  });
});
