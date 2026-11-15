/**
 * The Archon client against the fake Archon, which behaves as the spike found archon.krcg.org does
 * (docs/m7-plan.md, "Spike findings"): the same flows, refusals and quirks.
 */
import { describe, expect, it } from 'vitest';
import { act, readTournament } from './client.ts';
import { ArchonError } from './errors.ts';
import { FakeArchon } from './fake.ts';
import { type ArchonConfig, consentUrl, exchangeCode, pkce, refresh, userInfo } from './oauth.ts';

const REDIRECT = 'http://localhost:5173/archon/callback';

function setup() {
  const fake = new FakeArchon({ id: 'client', secret: 'shh', redirectUris: [REDIRECT] });
  const config: ArchonConfig = {
    baseUrl: fake.baseUrl,
    clientId: 'client',
    clientSecret: 'shh',
    redirectUri: REDIRECT,
    fetch: fake.fetch,
  };
  return { fake, config };
}

/** Open the consent page as the browser would, and read where Archon sends it back. */
async function consent(fake: FakeArchon, url: string) {
  const res = await fake.fetch(url, { redirect: 'manual' });
  return Object.fromEntries(new URL(res.headers.get('location') ?? '').searchParams);
}

describe('Archon OAuth', () => {
  it('links a member: consent, code, token, userinfo', async () => {
    const { fake, config } = setup();
    const ana = fake.addMember({ name: 'Ana', vekn_id: '1000001' });
    fake.signedIn = ana.uid;
    const { verifier, challenge } = pkce();
    const back = await consent(
      fake,
      consentUrl(config, { scope: 'profile:read', state: 's1', challenge }),
    );
    expect(back.state).toBe('s1');
    const tokens = await exchangeCode(config, back.code ?? '', verifier);
    expect(tokens.scope).toBe('profile:read');
    expect(await userInfo(config, tokens.access_token)).toEqual({
      sub: ana.uid,
      vekn_id: '1000001',
      roles: [],
    });
  });

  it('refuses a code with the wrong verifier, and a declined consent has no code', async () => {
    const { fake, config } = setup();
    fake.signedIn = fake.addMember({ name: 'Ana' }).uid;
    const { challenge } = pkce();
    const back = await consent(
      fake,
      consentUrl(config, { scope: 'profile:read', state: 's', challenge }),
    );
    await expect(exchangeCode(config, back.code ?? '', pkce().verifier)).rejects.toMatchObject({
      status: 400,
    });
    fake.signedIn = undefined;
    expect(
      await consent(fake, consentUrl(config, { scope: 'profile:read', state: 's', challenge })),
    ).toEqual({ state: 's', error: 'access_denied' });
  });

  it('rotates refresh tokens: the old one stops working', async () => {
    const { fake, config } = setup();
    fake.signedIn = fake.addMember({ name: 'Ana' }).uid;
    const { verifier, challenge } = pkce();
    const back = await consent(
      fake,
      consentUrl(config, { scope: 'profile:read', state: 's', challenge }),
    );
    const first = await exchangeCode(config, back.code ?? '', verifier);
    const second = await refresh(config, first.refresh_token ?? '');
    expect(second.refresh_token).not.toBe(first.refresh_token);
    await expect(refresh(config, first.refresh_token ?? '')).rejects.toBeInstanceOf(ArchonError);
  });

  it('only grants event:run on a tournament the member organises', async () => {
    const { fake, config } = setup();
    const org = fake.addMember({ name: 'Org', vekn_id: '1000002' });
    const other = fake.addMember({ name: 'Other', vekn_id: '1000003' });
    const t = fake.addTournament(org.uid);
    const { challenge } = pkce();
    fake.signedIn = other.uid;
    expect(
      (
        await consent(
          fake,
          consentUrl(config, { scope: 'event:run', state: 's', challenge, tournament: t.uid }),
        )
      ).error,
    ).toBe('access_denied');
    fake.signedIn = org.uid;
    expect(
      (
        await consent(
          fake,
          consentUrl(config, { scope: 'event:run', state: 's', challenge, tournament: t.uid }),
        )
      ).code,
    ).toBeTruthy();
  });
});

describe('a tournament through an event:run grant', () => {
  function tournament() {
    const { fake, config } = setup();
    const org = fake.addMember({ name: 'Org', vekn_id: '1000000' });
    const players = [1, 2, 3, 4].map((i) =>
      fake.addMember({ name: `P${i}`, vekn_id: `100000${i}` }),
    );
    const t = fake.addTournament(org.uid, { name: 'Test cup' });
    return { fake, config, t, players, token: fake.grant(org.uid, 'event:run', t.uid) };
  }

  it('plays a round: register, check in, Archon draws the table, scores, standings', async () => {
    const { fake, config, t, players, token } = tournament();
    const send = (a: Parameters<typeof act>[3]) => act(config, t.uid, token, a);
    await send({ type: 'OpenRegistration' });
    for (const p of players) {
      await send({ type: 'Register', user_uid: p.uid });
      await send({
        type: 'UpsertDeck',
        player_uid: p.uid,
        deck: { name: 'D', comments: '', cards: { '100001': 60, '200001': 12 } },
      });
    }
    await send({ type: 'CloseRegistration' });
    for (const p of players) await send({ type: 'CheckIn', player_uid: p.uid });
    await send({ type: 'StartRound' });
    let view = await readTournament(config, t.uid, token);
    expect(view.tournament.state).toBe('Playing');
    const seated = view.tournament.rounds[0]?.[0]?.seating.map((s) => s.player_uid) ?? [];
    expect(seated).toHaveLength(4);
    // Rounds and tables count from 0 in actions.
    await send({
      type: 'SetScore',
      round: 0,
      table: 0,
      scores: seated.map((uid, i) => ({ player_uid: uid, vp: [2.5, 0, 0, 0.5][i] ?? 0 })),
    });
    await send({ type: 'FinishRound' });
    view = await readTournament(config, t.uid, token);
    expect(view.tournament.state).toBe('Waiting');
    expect(view.tournament.standings[0]).toMatchObject({
      user_uid: seated[0],
      gw: 1,
      vp: 2.5,
      tp: 60,
    });
    expect(fake.decks.size).toBe(4);
  });

  it('keeps only uid, name and VEKN number of the members named', async () => {
    const { config, t, players, token } = tournament();
    await act(config, t.uid, token, { type: 'OpenRegistration' });
    await act(config, t.uid, token, { type: 'Register', user_uid: players[0]?.uid ?? '' });
    const { members } = await readTournament(config, t.uid, token);
    expect([...members.values()]).toEqual([
      { uid: players[0]?.uid, name: 'P1', vekn_id: '1000001' },
    ]);
  });

  it('turns refusals into ArchonErrors with their codes', async () => {
    const { fake, config, t, players, token } = tournament();
    const err = (p: Promise<unknown>) =>
      p.then(
        () => undefined,
        (e: ArchonError) => e,
      );
    const wrong = await err(act(config, t.uid, token, { type: 'StartRound' }));
    expect(wrong).toMatchObject({
      status: 400,
      code: 'tournament.wrong_state',
      params: { expected: 'Waiting', current: 'Planned' },
    });
    expect(wrong?.retryable).toBe(false);
    await act(config, t.uid, token, { type: 'OpenRegistration' });
    const noVekn = fake.addMember({ name: 'New' });
    expect(
      await err(act(config, t.uid, token, { type: 'Register', user_uid: noVekn.uid })),
    ).toMatchObject({ code: 'tournament.vekn_id_required' });
    // A grant names one tournament.
    const other = fake.addTournament(players[0]?.uid ?? '');
    expect(await err(readTournament(config, other.uid, token))).toMatchObject({ status: 403 });
  });

  it('marks a table that couldn’t have scored that Invalid, and won’t finish the round', async () => {
    const { config, t, players, token } = tournament();
    const send = (a: Parameters<typeof act>[3]) => act(config, t.uid, token, a);
    await send({ type: 'OpenRegistration' });
    for (const p of players) await send({ type: 'Register', user_uid: p.uid });
    await send({ type: 'CloseRegistration' });
    await send({ type: 'CheckInAll' });
    await send({ type: 'StartRound' });
    await send({
      type: 'SetScore',
      round: 0,
      table: 0,
      scores: players.map((p) => ({ player_uid: p.uid, vp: 2 })),
    });
    expect((await readTournament(config, t.uid, token)).tournament.rounds[0]?.[0]?.state).toBe(
      'Invalid',
    );
    await expect(send({ type: 'FinishRound' })).rejects.toMatchObject({
      code: 'tournament.tables_not_finished',
      params: { tables: '1' },
    });
  });

  it('says Archon is unreachable, and that it’s worth retrying', async () => {
    const { config, t, token } = tournament();
    const down: ArchonConfig = {
      ...config,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    };
    const e = await act(down, t.uid, token, { type: 'OpenRegistration' }).catch(
      (x: ArchonError) => x,
    );
    expect(e).toMatchObject({ status: 0, code: 'archon.unreachable' });
    expect((e as ArchonError).retryable).toBe(true);
  });
});
