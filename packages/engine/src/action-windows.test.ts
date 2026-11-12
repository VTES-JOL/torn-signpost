/**
 * The would-be-successful and after-resolution windows (zero-vtes docs/rules-digest.md §5.2, §10.1,
 * §10.4; rules-qa 5.8, 23.3, 24.2). Scenario 25 plays them; these cover the offers and the waits.
 */
import { describe, expect, it } from 'vitest';
import { decide } from './decide.ts';
import { waitingOn } from './flow.ts';
import type { GameState } from './model.ts';
import { availableActions } from './offers.ts';
import { project } from './projection.ts';
import { seededRng } from './rng.ts';
import { runScenario } from './scenario.ts';
import { testCatalog } from './testing/fixtures.ts';

/** Alice bleeds Bob with one of her two vampires; Bob passes. */
const SETUP = `seed 25
seat A alice
seat B bob
seat C carol
crypt A "Vera Nightfall" *12
library A "Iron Ward" *40
crypt B "Marek Hale" *12
library B "Iron Ward" *40
crypt C "Odile Fen" *12
library C "Iron Ward" *40
start
A> move A:uncontrolled:1 ready
A> move A:uncontrolled:1 ready
B> move B:uncontrolled:1 ready
A> next
A> next
A> bleed A:ready:1
B> pass
`;

const run = (more = '') => {
  const r = runScenario(SETUP + more, testCatalog);
  expect(r.failure).toBeUndefined();
  return r.state;
};

const offers = (state: GameState, seat: string) =>
  availableActions(project(state, { kind: 'player', seat }), seat, testCatalog);

/** The offer's command, with the first candidate for every step, as the engine sees it. */
const sendOffer = (state: GameState, seat: string, offerId: string) => {
  const offer = offers(state, seat).find((o) => o.id === offerId);
  if (!offer) throw new Error(`no offer ${offerId}`);
  const values = offer.steps.map((st) =>
    st.kind === 'card' ? st.candidates[0] : st.kind === 'amount' ? st.default : undefined,
  );
  const user = state.seats.find((x) => x.id === seat)?.occupant ?? '';
  const r = decide(state, offer.build(values), {
    actor: { kind: 'player', user },
    now: '2026-01-01T00:00:00.000Z',
    rng: seededRng(1),
    catalog: testCatalog,
  });
  return r.ok ? 'accepted' : r.rejection.message;
};

describe('the would-be-successful window', () => {
  it('waits on the acting Methuselah to resolve, offering the resolution with the window', () => {
    const s = run();
    expect(s.window?.kind).toBe('would-succeed');
    expect(waitingOn(s).map((w) => `${w.seat}:${w.kind}`)).toEqual(['A:resolve']);
    const ids = offers(s, 'A').map((o) => o.id);
    expect(ids).toEqual(['success', 'failure', 'enter-combat', 'play', 'pass', 'cancel']);
    expect(offers(s, 'A').find((o) => o.id === 'pass')?.primary).toBe(false);
    expect(offers(s, 'C').map((o) => o.id)).toEqual(['hold']);
    for (const id of ['success', 'failure', 'pass', 'cancel']) {
      expect(sendOffer(s, 'A', id)).toBe('accepted');
    }
  });
});

describe('the after-resolution window', () => {
  it('offers the acting Methuselah the next action and the end of the phase', () => {
    const s = run('A> resolve success 1\n');
    expect(s.action).toMatchObject({ stage: 'after', outcome: 'success' });
    expect(waitingOn(s).map((w) => `${w.seat}:${w.kind}`)).toEqual(['A:impulse']);
    const ids = offers(s, 'A').map((o) => o.id);
    expect(ids).toContain('pass');
    expect(ids).toContain('action:bleed');
    expect(ids).toContain('advance');
    expect(ids).not.toContain('cancel');
    expect(sendOffer(s, 'A', 'action:bleed')).toBe('accepted');
    expect(sendOffer(s, 'A', 'advance')).toBe('accepted');
    expect(sendOffer(s, 'A', 'pass')).toBe('accepted');
  });

  it('is passed by hand when someone holds it, and the action is over meanwhile', () => {
    const s = run('A> resolve success 1\nC> hold\n');
    expect(sendOffer(s, 'A', 'action:bleed')).toMatch(/may still play/);
    expect(sendOffer(s, 'A', 'advance')).toMatch(/may still play/);
    const r = runScenario(
      `${SETUP}A> resolve success 1\nC> hold\nreject:not-now A> cancel\nreject:not-now A> resolve success\nA> pass\nexpect impulse C\nC> pass\nexpect action none\n`,
      testCatalog,
    );
    expect(r.failure).toBeUndefined();
  });
});
