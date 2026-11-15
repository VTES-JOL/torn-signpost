/**
 * Linking Archon tournaments (docs/m7-plan.md M7.2) through the API, against DynamoDB Local and
 * the fake Archon: an organiser's grant, the pages, polling, refreshing a rotated grant, and a
 * grant Archon stops honouring.
 */
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { FakeArchon } from '@torn-signpost/archon/fake';
import type {
  ArchonCallbackResult,
  ArchonLinkStart,
  TournamentDetails,
  TournamentList,
} from '@torn-signpost/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { localSealer } from '../archon/sealer.ts';
import { ArchonService } from '../archon/service.ts';
import { devAuthenticator } from '../auth.ts';
import { ArchonStore } from '../db/archon.ts';
import { TournamentStore } from '../db/tournaments.ts';
import { dynamoAvailable, testStore } from '../testing/dynamo.ts';
import { TournamentService } from './service.ts';

const available = await dynamoAvailable();
const REDIRECT = 'http://localhost:5173/archon/callback';
/** Dev tokens: managing tournaments needs the `tournament_admin` group. */
const OLGA = 'olga:tournament_admin';
const SLY = 'sly:tournament_admin';

describe.skipIf(!available)('tournaments linked to Archon (DynamoDB Local)', () => {
  let cleanup: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  let fake: FakeArchon;
  let tournaments: TournamentService;
  let archonStore: ArchonStore;
  let raw: Awaited<ReturnType<typeof testStore>>;
  let now = new Date('2026-11-16T10:00:00Z');
  const later = (minutes: number) => {
    now = new Date(now.getTime() + minutes * 60 * 1000);
  };

  beforeAll(async () => {
    raw = await testStore();
    cleanup = raw.cleanup;
    fake = new FakeArchon({ id: 'client', secret: 'shh', redirectUris: [REDIRECT] });
    const config = async () => ({
      baseUrl: fake.baseUrl,
      clientId: 'client',
      clientSecret: 'shh',
      redirectUri: REDIRECT,
      fetch: fake.fetch,
    });
    archonStore = new ArchonStore(raw.db, raw.tableName);
    const archon: ArchonService = new ArchonService({
      store: archonStore,
      config,
      now: () => now,
      tournamentGranted: (sub, uid, tokens) => tournaments.granted(sub, uid, tokens),
    });
    tournaments = new TournamentService({
      store: new TournamentStore(raw.db, raw.tableName),
      archonStore,
      config,
      sealer: localSealer('test'),
      begin: (sub, purpose, t) => archon.begin(sub, purpose, t),
      nameOf: async (sub) => `@${sub}`,
      now: () => now,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    });
    app = createApp({
      stage: 'test',
      version: '1',
      allowedOrigins: [],
      auth: devAuthenticator,
      archon,
      tournaments,
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
    const text = await res.text();
    return {
      status: res.status,
      body: (text ? JSON.parse(text) : {}) as T & { error?: string },
    };
  };

  /** `user` links the tournament, approving in Archon as `member` (or declining: undefined). */
  const link = async (user: string, member: string | undefined, archon: string) => {
    const start = await call<ArchonLinkStart>('POST', '/tournaments/link', user, { archon });
    expect(start.status).toBe(200);
    const consent = new URL(start.body.url);
    expect(consent.searchParams.get('scope')).toBe('event:run');
    fake.signedIn = member;
    const res = await fake.fetch(start.body.url, { redirect: 'manual' });
    const back = Object.fromEntries(new URL(res.headers.get('location') ?? '').searchParams);
    return call<ArchonCallbackResult>('POST', '/archon/callback', user, back);
  };

  /** A tournament in Archon, run by a member who is `org` here, with four registered players. */
  const setUp = (name: string) => {
    const org = fake.addMember({ name: `${name} organiser`, vekn_id: '3000001' });
    const players = ['Ana', 'Ben', 'Cy', 'Dee'].map((n, i) =>
      fake.addMember({ name: `${n} ${name}`, vekn_id: `30000${i + 10}` }),
    );
    const t = fake.addTournament(org.uid, {
      name,
      online: false,
      venue: 'The Elysium',
      city: 'Lyon',
      country: 'France',
      start: '2026-12-05T10:00:00Z',
    });
    fake.act(t.uid, { type: 'OpenRegistration' });
    for (const p of players) fake.act(t.uid, { type: 'Register', user_uid: p.uid });
    return { org, players, t };
  };

  it('links a tournament its organiser runs, and shows it', async () => {
    const { org, players, t } = setUp('Lyon Open');
    const done = await link(OLGA, org.uid, `${fake.baseUrl}/tournaments/${t.uid}`);
    expect(done).toMatchObject({
      status: 200,
      body: { purpose: 'tournament', tournamentId: t.uid },
    });

    const list = await call<TournamentList>('GET', '/tournaments');
    expect(list.body.tournaments).toContainEqual(
      expect.objectContaining({
        id: t.uid,
        name: 'Lyon Open',
        state: 'Registration',
        place: 'The Elysium, Lyon, France',
        players: 4,
        organiser: '@olga',
        archonUrl: `${fake.baseUrl}/tournaments/${t.uid}`,
      }),
    );

    // Guests see the summary; players, rounds and standings are for signed-in players.
    const guest = await call<TournamentDetails>('GET', `/tournaments/${t.uid}`);
    expect(guest.body).toMatchObject({ name: 'Lyon Open', officials: ['Lyon Open organiser'] });
    expect(guest.body.detail).toBeUndefined();
    expect(guest.body.manage).toBeUndefined();

    // A player who linked their Archon account shows with their name here.
    const [ana] = players;
    await archonStore.putLink(
      'ana',
      { archonUid: ana?.uid ?? '', veknId: ana?.vekn_id ?? null, linkedAt: now.toISOString() },
      undefined,
    );
    const seen = await call<TournamentDetails>('GET', `/tournaments/${t.uid}`, 'zed');
    expect(seen.body.detail?.players).toHaveLength(4);
    expect(seen.body.detail?.players[0]).toMatchObject({
      name: 'Ana Lyon Open',
      veknId: '3000010',
      state: 'Registered',
      missingDecklist: true,
      account: '@ana',
    });
    expect(seen.body.detail?.players[1]?.account).toBeNull();
    expect(seen.body.manage).toBeUndefined();
    const own = await call<TournamentDetails>('GET', `/tournaments/${t.uid}`, OLGA);
    expect(own.body.manage).toEqual({ grant: 'ok', lastError: null });
  });

  it('keeps the grant sealed', async () => {
    const { org, t } = setUp('Sealed');
    await link(OLGA, org.uid, t.uid);
    const { Item } = await raw.db.send(
      new GetCommand({ TableName: raw.tableName, Key: { PK: `TOURN#${t.uid}`, SK: 'GRANT' } }),
    );
    expect(Item?.archonSub).toBe(org.uid);
    // Archon's tokens are JWTs (three dot-separated parts); sealed, they're opaque base64.
    expect(String(Item?.access)).not.toContain('.');
    expect(String(Item?.refresh)).toMatch(/^[A-Za-z0-9+/=]+$/);
    // The state we keep has no member contact details or check-in code.
    const { Item: state } = await raw.db.send(
      new GetCommand({ TableName: raw.tableName, Key: { PK: `TOURN#${t.uid}`, SK: 'STATE' } }),
    );
    expect(String(state?.body)).not.toContain('contact_email');
    expect(String(state?.body)).not.toContain('checkin_code');
  });

  it('refuses a tournament the player doesn’t run in Archon, or an address elsewhere', async () => {
    const { t } = setUp('Not yours');
    const stranger = fake.addMember({ name: 'Stranger', vekn_id: '3000099' });
    expect(await link(SLY, stranger.uid, t.uid)).toMatchObject({
      status: 400,
      body: { error: 'archon_declined' },
    });
    expect(
      await call('POST', '/tournaments/link', SLY, {
        archon: `https://elsewhere.example/tournaments/${t.uid}`,
      }),
    ).toMatchObject({ status: 400, body: { error: 'archon_tournament' } });
    expect(await call('POST', '/tournaments/link', SLY, { archon: 'my tournament' })).toMatchObject(
      { status: 400, body: { error: 'archon_tournament' } },
    );
    expect((await call('POST', '/tournaments/link', undefined, { archon: t.uid })).status).toBe(
      401,
    );
    // Only tournament admins link tournaments: not players, not admins.
    for (const user of ['pat', 'ada:admin', 'jo:judge']) {
      expect(await call('POST', '/tournaments/link', user, { archon: t.uid })).toMatchObject({
        status: 403,
        body: { error: 'tournament_admin_only' },
      });
    }
    expect((await call('GET', `/tournaments/${t.uid}`)).status).toBe(404);
  });

  it('follows the tournament by polling: rounds, tables and standings', async () => {
    const { org, players, t } = setUp('Polled');
    await link(OLGA, org.uid, t.uid);
    fake.act(t.uid, { type: 'CloseRegistration' });
    // Registration and Waiting differ in how often they're read; it was read at link time.
    later(1);
    await tournaments.poll();
    let page = await call<TournamentDetails>('GET', `/tournaments/${t.uid}`, 'zed');
    expect(page.body.state).toBe('Registration');
    later(15);
    await tournaments.poll();
    page = await call<TournamentDetails>('GET', `/tournaments/${t.uid}`, 'zed');
    expect(page.body.state).toBe('Waiting');

    // Under way, every poll reads it.
    fake.act(t.uid, { type: 'CheckInAll' });
    fake.act(t.uid, { type: 'StartRound' });
    later(1);
    await tournaments.poll();
    page = await call<TournamentDetails>('GET', `/tournaments/${t.uid}`, 'zed');
    expect(page.body.state).toBe('Playing');
    expect(page.body.detail?.rounds).toEqual([
      {
        number: 1,
        tables: [
          expect.objectContaining({
            number: 1,
            state: 'In Progress',
            seats: players.map((p) => expect.objectContaining({ archonUid: p.uid, name: p.name })),
          }),
        ],
      },
    ]);

    // A 4-player table scores as places 1, 2, 4 and 5 of a 5-player one, ties sharing the
    // average (VEKN tournament rules 3.7.4; Archon computes it): 2-1-1-0 is 60, 36, 36, 12 TP.
    const [a, b, c, d] = players.map((p) => p.uid);
    fake.act(t.uid, {
      type: 'SetScore',
      round: 0,
      table: 0,
      scores: [
        { player_uid: a ?? '', vp: 2 },
        { player_uid: b ?? '', vp: 1 },
        { player_uid: c ?? '', vp: 1 },
        { player_uid: d ?? '', vp: 0 },
      ],
    });
    fake.act(t.uid, { type: 'FinishRound' });
    later(1);
    await tournaments.poll();
    page = await call<TournamentDetails>('GET', `/tournaments/${t.uid}`, 'zed');
    expect(page.body.detail?.standings.map((s) => [s.rank, s.archonUid, s.gw, s.vp, s.tp])).toEqual(
      [
        [1, a, 1, 2, 60],
        [2, b, 0, 1, 36],
        [2, c, 0, 1, 36],
        [4, d, 0, 0, 12],
      ],
    );
  });

  it('refreshes the grant when its access token runs out, keeping the rotated refresh token', async () => {
    const { org, t } = setUp('Refreshed');
    await link(OLGA, org.uid, t.uid);
    fake.act(t.uid, { type: 'CloseRegistration' });
    for (const _ of [1, 2]) {
      fake.expireAccess();
      later(61);
      await tournaments.poll();
      const page = await call<TournamentDetails>('GET', `/tournaments/${t.uid}`, OLGA);
      expect(page.body.manage).toEqual({ grant: 'ok', lastError: null });
      expect(page.body.state).toBe('Waiting');
    }
    // Two reads at once: one refreshes, the other waits for it (a spent refresh token would
    // lose the grant).
    fake.expireAccess();
    later(61);
    const both = await Promise.all([
      call('POST', `/tournaments/${t.uid}/refresh`, OLGA),
      call('POST', `/tournaments/${t.uid}/refresh`, OLGA),
    ]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    fake.expireAccess();
    later(61);
    const after = await call<TournamentDetails>('POST', `/tournaments/${t.uid}/refresh`, OLGA);
    expect(after.body.manage).toEqual({ grant: 'ok', lastError: null });
  });

  it('says so when Archon stops honouring the grant, until it’s linked again', async () => {
    const { org, t } = setUp('Revoked');
    await link(OLGA, org.uid, t.uid);
    fake.revoke(t.uid);
    later(61);
    const page = await call<TournamentDetails>('POST', `/tournaments/${t.uid}/refresh`, OLGA);
    expect(page.body.manage).toEqual({
      grant: 'lost',
      lastError: 'Archon no longer accepts our grant',
    });
    // The copy we had is still shown.
    expect(page.body.name).toBe('Revoked');
    expect((await link(OLGA, org.uid, t.uid)).status).toBe(200);
    const again = await call<TournamentDetails>('GET', `/tournaments/${t.uid}`, OLGA);
    expect(again.body.manage).toEqual({ grant: 'ok', lastError: null });
  });

  it('lets only tournament admins who organise it in Archon refresh or unlink it', async () => {
    const { org, t } = setUp('Guarded');
    await link(OLGA, org.uid, t.uid);
    const refreshAs = (user: string) =>
      call<TournamentDetails>('POST', `/tournaments/${t.uid}/refresh`, user);
    // Not tournament admins: refused, whatever else they are.
    for (const user of ['mallory', 'ada:admin', 'jo:judge']) {
      expect(await refreshAs(user)).toMatchObject({
        status: 403,
        body: { error: 'tournament_admin_only' },
      });
      expect((await call('DELETE', `/tournaments/${t.uid}`, user)).status).toBe(403);
      const page = await call<TournamentDetails>('GET', `/tournaments/${t.uid}`, user);
      expect(page.body.manage).toBeUndefined();
    }
    // A tournament admin who doesn't organise it in Archon: refused too.
    const TIA = 'tia:tournament_admin';
    const tia = fake.addMember({ name: 'Tia', vekn_id: '3000077' });
    await archonStore.putLink(
      'tia',
      { archonUid: tia.uid, veknId: tia.vekn_id, linkedAt: now.toISOString() },
      undefined,
    );
    expect(await refreshAs(TIA)).toMatchObject({ status: 403, body: { error: 'not_organiser' } });
    expect(
      (await call<TournamentDetails>('GET', `/tournaments/${t.uid}`, TIA)).body.manage,
    ).toBeUndefined();
    // Made an organiser in Archon, she can, once we've read that (her linked Archon account
    // shows it's her), though she didn't link it here.
    fake.tournaments.get(t.uid)?.organizers_uids.push(tia.uid);
    expect((await refreshAs(OLGA)).status).toBe(200);
    expect(await refreshAs(TIA)).toMatchObject({ status: 200, body: { manage: { grant: 'ok' } } });
    // The one who linked it is known to Archon by the grant, linked account or not.
    expect((await call('DELETE', `/tournaments/${t.uid}`, OLGA)).status).toBe(204);
    expect((await call('GET', `/tournaments/${t.uid}`)).status).toBe(404);
    const list = await call<TournamentList>('GET', '/tournaments');
    expect(list.body.tournaments.map((x) => x.id)).not.toContain(t.uid);
  });
});
