/**
 * Linking an Archon account (docs/m7-plan.md M7.1) through the API, against DynamoDB Local and
 * the fake Archon: the whole round trip, and each way it can go wrong.
 */
import { FakeArchon } from '@torn-signpost/archon/fake';
import type { ArchonCallbackResult, ArchonLink, ArchonLinkStart } from '@torn-signpost/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { devAuthenticator } from '../auth.ts';
import { ArchonStore } from '../db/archon.ts';
import { dynamoAvailable, testStore } from '../testing/dynamo.ts';
import { ArchonService } from './service.ts';

const available = await dynamoAvailable();
const REDIRECT = 'http://localhost:5173/archon/callback';

describe.skipIf(!available)('linking an Archon account (DynamoDB Local)', () => {
  let cleanup: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  let fake: FakeArchon;
  let now = new Date('2026-11-16T10:00:00Z');
  beforeAll(async () => {
    const t = await testStore();
    cleanup = t.cleanup;
    fake = new FakeArchon({ id: 'client', secret: 'shh', redirectUris: [REDIRECT] });
    app = createApp({
      stage: 'test',
      version: '1',
      allowedOrigins: [],
      auth: devAuthenticator,
      archon: new ArchonService({
        store: new ArchonStore(t.db, t.tableName),
        config: async () => ({
          baseUrl: fake.baseUrl,
          clientId: 'client',
          clientSecret: 'shh',
          redirectUri: REDIRECT,
          fetch: fake.fetch,
        }),
        now: () => now,
      }),
    });
  });
  afterAll(() => cleanup?.());

  const call = async <T>(method: string, path: string, user?: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(user ? { Authorization: `Bearer dev:${user}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as T & { error?: string } };
  };

  /** Start a link as `user`, approve it in (fake) Archon, and return what Archon sent back. */
  const approve = async (user: string, member: string | undefined) => {
    const { body } = await call<ArchonLinkStart>('POST', '/me/archon/link', user);
    expect(body.url).toContain('/consent?');
    expect(new URL(body.url).searchParams.get('scope')).toBe('profile:read');
    fake.signedIn = member;
    const res = await fake.fetch(body.url, { redirect: 'manual' });
    return Object.fromEntries(new URL(res.headers.get('location') ?? '').searchParams);
  };

  it('links, shows and unlinks an account', async () => {
    const ana = fake.addMember({ name: 'Ana', vekn_id: '1000001' });
    expect((await call<ArchonLink>('GET', '/me/archon', 'ana')).body).toEqual({ linked: false });
    const back = await approve('ana', ana.uid);
    const done = await call<ArchonCallbackResult>('POST', '/archon/callback', 'ana', back);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      purpose: 'profile',
      link: { linked: true, archonUid: ana.uid, veknId: '1000001' },
    });
    expect((await call<ArchonLink>('GET', '/me/archon', 'ana')).body).toMatchObject({
      archonUid: ana.uid,
    });
    expect((await call<ArchonLink>('DELETE', '/me/archon', 'ana')).body).toEqual({ linked: false });
    expect((await call<ArchonLink>('GET', '/me/archon', 'ana')).body).toEqual({ linked: false });
  });

  it('keeps a member without a VEKN number, so registration can say so', async () => {
    const ben = fake.addMember({ name: 'Ben' });
    const done = await call<ArchonCallbackResult>(
      'POST',
      '/archon/callback',
      'ben',
      await approve('ben', ben.uid),
    );
    expect(done.body).toMatchObject({ link: { linked: true, archonUid: ben.uid, veknId: null } });
  });

  it('links an Archon account to one Torn Signpost account at a time', async () => {
    const cy = fake.addMember({ name: 'Cy', vekn_id: '1000003' });
    expect((await call('POST', '/archon/callback', 'cy', await approve('cy', cy.uid))).status).toBe(
      200,
    );
    const again = await call('POST', '/archon/callback', 'cy2', await approve('cy2', cy.uid));
    expect(again).toMatchObject({ status: 409, body: { error: 'archon_taken' } });
    // Unlinked, it's free for someone else.
    await call('DELETE', '/me/archon', 'cy');
    expect(
      (await call('POST', '/archon/callback', 'cy2', await approve('cy2', cy.uid))).status,
    ).toBe(200);
  });

  it('moves the claim when a player links a different Archon account', async () => {
    const d1 = fake.addMember({ name: 'D1', vekn_id: '1000004' });
    const d2 = fake.addMember({ name: 'D2', vekn_id: '1000005' });
    await call('POST', '/archon/callback', 'dee', await approve('dee', d1.uid));
    await call('POST', '/archon/callback', 'dee', await approve('dee', d2.uid));
    // d1 is free again.
    expect(
      (await call('POST', '/archon/callback', 'eve', await approve('eve', d1.uid))).status,
    ).toBe(200);
  });

  it('refuses a callback that isn’t the player’s own, a replay, a stale one, or a declined one', async () => {
    const fay = fake.addMember({ name: 'Fay', vekn_id: '1000006' });
    const back = await approve('fay', fay.uid);
    expect(await call('POST', '/archon/callback', 'mallory', back)).toMatchObject({
      status: 400,
      body: { error: 'archon_link_expired' },
    });
    // Taken by that attempt: a request completes once.
    expect(await call('POST', '/archon/callback', 'fay', back)).toMatchObject({
      status: 400,
      body: { error: 'archon_link_expired' },
    });
    const late = await approve('fay', fay.uid);
    now = new Date(now.getTime() + 16 * 60 * 1000);
    expect(await call('POST', '/archon/callback', 'fay', late)).toMatchObject({
      status: 400,
      body: { error: 'archon_link_expired' },
    });
    const declined = await approve('fay', undefined);
    expect(declined.error).toBe('access_denied');
    expect(await call('POST', '/archon/callback', 'fay', declined)).toMatchObject({
      status: 400,
      body: { error: 'archon_declined' },
    });
  });

  it('needs a signed-in player', async () => {
    expect((await call('POST', '/me/archon/link')).status).toBe(401);
  });
});
