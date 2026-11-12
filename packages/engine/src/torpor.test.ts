/**
 * Leaving torpor, diablerie by a blocker, and changing blockers (rulebook, "Leave Torpor",
 * "Diablerie"; zero-vtes rules-qa 48.3, 114.1). Scenario 24 plays the main paths; these cover the
 * edges.
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

/** Alice has a vampire in torpor (3 blood); Bob a vampire and an ally; Carol a vampire. */
const SETUP = `seed 24
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
A> move A:ready:1 torpor
B> transfer +4 B:uncontrolled:1
B> move B:uncontrolled:1 ready
B> move B:hand:1 ready
C> transfer +5 C:uncontrolled:1
C> move C:uncontrolled:1 ready
A> next
A> next
A> leavetorpor A:torpor:1
`;

const run = (more = '') => {
  const r = runScenario(SETUP + more, testCatalog);
  expect(r.failure).toBeUndefined();
  return r.state;
};

const send = (state: GameState, cmd: Command, user: string) => {
  const r = decide(state, cmd, {
    actor: { kind: 'player', user },
    now: '2026-01-01T00:00:00.000Z',
    rng: seededRng(1),
    catalog: testCatalog,
  });
  return r.ok ? 'accepted' : r.rejection.message;
};

const offerIds = (state: GameState, seat: string) =>
  availableActions(project(state, { kind: 'player', seat }), seat, testCatalog).map((o) => o.id);

describe('leaving torpor (rulebook, "Leave Torpor")', () => {
  it('is offered for a vampire in torpor, and is the only action it may take', () => {
    const before = runScenario(SETUP.replace('A> leavetorpor A:torpor:1\n', ''), testCatalog);
    expect(before.failure).toBeUndefined();
    expect(offerIds(before.state, 'A')).toContain('action:leave-torpor');
    const torpid = before.state.zones['A:torpor']?.[0] ?? '';
    expect(
      send(before.state, { type: 'DeclareAction', kind: 'hunt', minion: torpid }, 'alice'),
    ).toMatch(/ready region/);
    // A ready minion can't "leave torpor".
    const ready = before.state.zones['B:ready']?.[0] ?? '';
    expect(
      send(before.state, { type: 'DeclareAction', kind: 'leave-torpor', minion: ready }, 'alice'),
    ).toMatch(/vampires in torpor/);
  });

  it('is undirected: the prey and the predator may block', () => {
    const s = run();
    expect(s.action?.target).toBeUndefined();
    expect([...(s.action?.eligible ?? [])].sort()).toEqual(['B', 'C']);
  });

  it('cannot enter combat, and pays what a card makes the cost', () => {
    const s = run('B> pass\nC> pass\n');
    const opponent = s.zones['C:ready']?.[0] ?? '';
    expect(send(s, { type: 'ResolveAction', outcome: 'combat', opponent }, 'alice')).toMatch(
      /cannot enter combat/,
    );
    expect(offerIds(s, 'A')).not.toContain('enter-combat');
    const free = runScenario(`${SETUP}B> pass\nC> pass\nA> resolve success 0\n`, testCatalog);
    expect(free.failure).toBeUndefined();
    const vera = free.state.zones['A:ready']?.[0] ?? '';
    expect(free.state.cards[vera]?.counters.blood).toBe(3);
  });

  it('blocked by an ally, simply fails: no diablerie, nothing paid', () => {
    const s = run('B> block B:ready:2\nA> pass\nB> pass\nC> pass\n');
    expect(s.action).toBeUndefined();
    const vera = s.zones['A:torpor']?.[0] ?? '';
    expect(s.cards[vera]?.counters.blood).toBe(3);
  });

  it('blocked by a vampire, waits on its Methuselah alone', () => {
    const s = run('B> block B:ready:1\nA> pass\nB> pass\nC> pass\n');
    expect(s.action?.stage).toBe('diablerie');
    expect(offerIds(s, 'B')).toEqual(['diablerize', 'no-diablerie']);
    expect(offerIds(s, 'A')).not.toContain('diablerize');
    expect(send(s, { type: 'Diablerize' }, 'alice')).toMatch(/blocking vampire/);
    expect(send(s, { type: 'Diablerize' }, 'bob')).toBe('accepted');
    const before = run();
    expect(send(before, { type: 'Diablerize' }, 'bob')).toMatch(/no diablerie/);
  });
});

describe('changing blockers (zero-vtes rules-qa 48.3, 114.1)', () => {
  it('lets the attempting Methuselah switch minions, and nobody else attempt meanwhile', () => {
    const s = run('B> block B:ready:1\nA> pass\n');
    expect(offerIds(s, 'B')).toContain('block-switch');
    const first = s.action?.blockAttempt?.minion ?? '';
    expect(send(s, { type: 'Block', minion: first }, 'bob')).toMatch(/already attempting/);
    const other = s.zones['B:ready']?.find((m) => m !== first) ?? '';
    expect(send(s, { type: 'Block', minion: other }, 'bob')).toBe('accepted');
    // Carol can't start a second attempt while Bob's is under way.
    const carol = run('B> block B:ready:1\nA> pass\nB> pass\n');
    const hers = carol.zones['C:ready']?.[0] ?? '';
    expect(send(carol, { type: 'Block', minion: hers }, 'carol')).toMatch(/already pending/);
  });
});

describe('the offers', () => {
  /** The offer's command, with the first candidate for every step, as the engine sees it. */
  const sendOffer = (state: GameState, seat: string, offerId: string) => {
    const offers = availableActions(project(state, { kind: 'player', seat }), seat, testCatalog);
    const offer = offers.find((o) => o.id === offerId);
    if (!offer) throw new Error(`no offer ${offerId}`);
    const values = offer.steps.map((st) =>
      st.kind === 'card' ? st.candidates[0] : st.kind === 'amount' ? st.default : undefined,
    );
    const user = state.seats.find((x) => x.id === seat)?.occupant ?? '';
    return send(state, offer.build(values), user);
  };

  it('build commands the engine accepts', () => {
    const before = runScenario(SETUP.replace('A> leavetorpor A:torpor:1\n', ''), testCatalog);
    expect(sendOffer(before.state, 'A', 'action:leave-torpor')).toBe('accepted');
    expect(sendOffer(run('B> pass\nC> pass\n'), 'A', 'success')).toBe('accepted');
    expect(sendOffer(run('B> block B:ready:1\nA> pass\n'), 'B', 'block-switch')).toBe('accepted');
    const blocked = run('B> block B:ready:1\nA> pass\nB> pass\nC> pass\n');
    expect(sendOffer(blocked, 'B', 'diablerize')).toBe('accepted');
    expect(sendOffer(blocked, 'B', 'no-diablerie')).toBe('accepted');
  });
});

describe('the console', () => {
  it('parses leavetorpor and diablerize', () => {
    const s = run('B> block B:ready:1\nA> pass\nB> pass\nC> pass\n');
    const parsed = (line: string, seat: string) => {
      const r = parseConsole(line, { view: s, catalog: testCatalog, seat });
      return r.ok ? r.command : r.error;
    };
    expect(parsed('diablerize', 'B')).toEqual({ type: 'Diablerize' });
    expect(parsed('diablerize no', 'B')).toEqual({ type: 'Diablerize', decline: true });
    expect(parsed('diablerize maybe', 'B')).toMatch(/Usage/);
    expect(parsed('leavetorpor', 'A')).toMatch(/Usage/);
  });
});
