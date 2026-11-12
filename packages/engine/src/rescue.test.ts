/**
 * Rescue and diablerie as actions (rulebook; zero-vtes digest §11.6, §11.7). Scenario 28 plays
 * them; these cover the offers, the console and the checks.
 */
import { describe, expect, it } from 'vitest';
import type { Command } from './commands.ts';
import { parseConsole } from './console/index.ts';
import { decide } from './decide.ts';
import type { GameState } from './model.ts';
import { availableActions } from './offers.ts';
import { project } from './projection.ts';
import { seededRng } from './rng.ts';
import { runScenario } from './scenario.ts';
import { testCatalog } from './testing/fixtures.ts';

/** Alice has a ready vampire (3 blood) and one in torpor; Bob a vampire in torpor (2 blood), and an ally. */
const SETUP = `seed 28
seat A alice
seat B bob
seat C carol
crypt A "Vera Nightfall" *12
library A "Iron Ward" *40
crypt B "Marek Hale" *12
library B "Gate Hound" *40
crypt C "Odile Fen" *12
library C "Iron Ward" *40
start
A> transfer +3 A:uncontrolled:1
A> move A:uncontrolled:1 ready
A> transfer +1 A:uncontrolled:1
A> move A:uncontrolled:1 ready
A> move A:ready:2 torpor
B> transfer +2 B:uncontrolled:1
B> move B:uncontrolled:1 ready
B> move B:ready:1 torpor
B> move B:hand:1 ready
A> next
A> next
`;

const run = (more = '') => {
  const r = runScenario(SETUP + more, testCatalog);
  expect(r.failure).toBeUndefined();
  return r.state;
};

const send = (state: GameState, cmd: Command, user = 'alice') => {
  const r = decide(state, cmd, {
    actor: { kind: 'player', user },
    now: '2026-01-01T00:00:00.000Z',
    rng: seededRng(1),
    catalog: testCatalog,
  });
  return r.ok ? 'accepted' : r.rejection.message;
};

const offers = (state: GameState, seat: string) =>
  availableActions(project(state, { kind: 'player', seat }), seat, testCatalog);

/** The offer's command, with the given values (or the first candidate / default for each step). */
const sendOffer = (state: GameState, seat: string, offerId: string, picks: unknown[] = []) => {
  const offer = offers(state, seat).find((o) => o.id === offerId);
  if (!offer) throw new Error(`no offer ${offerId}`);
  const values = offer.steps.map((st, i) =>
    picks[i] !== undefined
      ? picks[i]
      : st.kind === 'card'
        ? st.candidates[0]
        : st.kind === 'amount'
          ? st.default
          : undefined,
  );
  return send(state, offer.build(values as never));
};

describe('rescue and diablerie', () => {
  it('are offered for a ready vampire and anyone’s vampire in torpor, not an ally', () => {
    const s = run();
    const rescue = offers(s, 'A').find((o) => o.id === 'action:rescue');
    const torpid = rescue?.steps[1];
    expect(torpid?.kind === 'card' ? [...torpid.candidates].sort() : []).toEqual(
      [s.zones['A:torpor']?.[0], s.zones['B:torpor']?.[0]].sort(),
    );
    expect(sendOffer(s, 'A', 'action:rescue')).toBe('accepted');
    expect(sendOffer(s, 'A', 'action:diablerie')).toBe('accepted');
  });

  it('is directed at the vampire’s controller when it’s another’s, undirected when it’s yours', () => {
    const theirs = run(`A> diablerie A:ready:1 B:torpor:1\n`);
    expect(theirs.action).toMatchObject({ kind: 'diablerie', target: 'B', eligible: ['B'] });
    const mine = run(`A> rescue A:ready:1 A:torpor:1\n`);
    expect(mine.action?.target).toBeUndefined();
    expect([...(mine.action?.eligible ?? [])].sort()).toEqual(['B', 'C']);
  });

  it('refuses a vampire not in torpor, none named, or a share over the cost', () => {
    const s = run();
    const ready = s.zones['A:ready']?.[0] ?? '';
    const torpid = s.zones['B:torpor']?.[0] ?? '';
    expect(
      send(s, { type: 'DeclareAction', kind: 'rescue', minion: ready, vampire: ready }),
    ).toMatch(/vampire in torpor/);
    expect(send(s, { type: 'DeclareAction', kind: 'diablerie', minion: ready })).toMatch(
      /Which vampire/,
    );
    expect(
      send(s, {
        type: 'DeclareAction',
        kind: 'rescue',
        minion: ready,
        vampire: torpid,
        rescuedPays: 3,
      }),
    ).toMatch(/pays 0 to 2/);
  });

  it('offers the resolution, and the console parses both', () => {
    const s = run(`A> rescue A:ready:1 B:torpor:1 1\nB> pass\n`);
    expect(s.action?.rescuedPays).toBe(1);
    const success = offers(s, 'A').find((o) => o.id === 'success');
    expect(success?.label).toBe('Successful: rescued');
    expect(sendOffer(s, 'A', 'success')).toBe('accepted');
    const parsed = (line: string) => {
      const r = parseConsole(line, { view: s, catalog: testCatalog, seat: 'A' });
      return r.ok ? r.command : r.error;
    };
    expect(parsed('rescue A:ready:1')).toMatch(/Usage/);
    expect(parsed('diablerie A:ready:1')).toMatch(/Usage/);
  });
});
