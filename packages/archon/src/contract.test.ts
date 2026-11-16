/**
 * Contract checks against a real Archon, so the fake doesn't drift from it. Skipped unless
 * `ARCHON_CONTRACT` names a JSON file `{baseUrl, tournament, accessToken}`: an `event:run` access
 * token for a test tournament (an hour's worth; see docs/testing.md). Reads, and actions Archon
 * refuses without changing anything (an unknown action, or a player who isn't there).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { act, readTournament } from './client.ts';
import { type ArchonConfig, tokenClaims } from './oauth.ts';

const file = process.env.ARCHON_CONTRACT;
const live = file
  ? (JSON.parse(readFileSync(file, 'utf8')) as {
      baseUrl: string;
      tournament: string;
      accessToken: string;
    })
  : undefined;
const config: ArchonConfig = {
  baseUrl: live?.baseUrl ?? '',
  clientId: '',
  clientSecret: '',
  redirectUri: '',
};

describe.runIf(live)('the real Archon', () => {
  it('sends the tournament the client reads, with the fields we use', async () => {
    const { tournament: t, members } = await readTournament(
      config,
      live?.tournament ?? '',
      live?.accessToken ?? '',
    );
    expect(t.uid).toBe(live?.tournament);
    expect(['Planned', 'Registration', 'Waiting', 'Playing', 'Finals', 'Finished']).toContain(
      t.state,
    );
    for (const key of ['players', 'rounds', 'standings', 'round_time', 'max_rounds', 'multideck']) {
      expect(t, key).toHaveProperty(key);
    }
    for (const p of t.players) {
      expect(p).toMatchObject({ user_uid: expect.any(String), state: expect.any(String) });
      expect(p.result).toMatchObject({
        gw: expect.any(Number),
        vp: expect.any(Number),
        tp: expect.any(Number),
      });
    }
    for (const table of t.rounds.flat()) {
      expect(table).toMatchObject({ state: expect.any(String) });
      for (const s of table.seating) expect(s.player_uid).toEqual(expect.any(String));
    }
    for (const m of members.values())
      expect(Object.keys(m).sort()).toEqual(['name', 'uid', 'vekn_id']);
    // Its officials, and their names among the members sent (M7.2's tournament page).
    expect(t.organizers_uids?.length).toBeGreaterThan(0);
    for (const uid of t.organizers_uids ?? []) expect(members.get(uid)?.name).toBeTruthy();
  });

  it('issues event:run tokens that name their tournament and who granted them', () => {
    expect(tokenClaims(live?.accessToken ?? '')).toMatchObject({
      scope: 'event:run',
      tournament: live?.tournament,
      sub: expect.any(String),
      exp: expect.any(Number),
    });
  });

  it('understands the registration actions (refused for a player who isn’t there)', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    const send = (action: Parameters<typeof act>[3]) =>
      act(config, live?.tournament ?? '', live?.accessToken ?? '', action).catch((x) => x);
    expect(await send({ type: 'AddPlayer', user_uid: ghost })).toMatchObject({ status: 404 });
    expect(
      await send({
        type: 'UpsertDeck',
        player_uid: ghost,
        deck: { name: 'x', comments: '', cards: { '100038': 1 } },
      }),
    ).toMatchObject({ status: 400, code: 'tournament.not_registered' });
    expect(await send({ type: 'DropOut', player_uid: ghost })).toMatchObject({
      status: 400,
      code: 'tournament.player_not_found',
    });
    expect(await send({ type: 'CheckIn', player_uid: ghost })).toMatchObject({ status: 404 });
    // Unregister names the member (`user_uid`), and only during registration.
    const unregister = await send({ type: 'Unregister', user_uid: ghost });
    expect(unregister.code).not.toBe('internal');
  });

  it('refuses an unknown action with its error shape', async () => {
    const e = await act(config, live?.tournament ?? '', live?.accessToken ?? '', {
      type: 'NoSuchThing',
    } as never).catch((x) => x);
    expect(e).toMatchObject({ status: 400, code: 'internal' });
  });
});
