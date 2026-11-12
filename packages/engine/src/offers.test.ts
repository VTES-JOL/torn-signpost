import { describe, expect, it } from 'vitest';
import { type CardInfo, createCatalog } from './catalog.ts';
import { availableActions } from './offers.ts';
import { project } from './projection.ts';
import { runScenario } from './scenario.ts';
import { testCatalog } from './testing/fixtures.ts';

// The test catalog with card types, so offers can filter by them.
const TYPES: Record<string, string[]> = {
  'Iron Ward': ['Equipment'],
  'Signal Fire': ['Master'],
  'Quick Feed': ['Reaction'],
};
const catalog = createCatalog(
  testCatalog.all().map((c): CardInfo => {
    const types = TYPES[c.name];
    return types ? { ...c, types } : c;
  }),
);

const SETUP = `
seed 5
seat A alice
seat B bob
seat C carol
crypt A "Vera Nightfall" *12
library A "Iron Ward" *40
crypt B "Tomas Grey" *12
library B "Quick Feed" *40
crypt C "Ilse Várga" *12
library C "Signal Fire" *40
start
A> move A:uncontrolled:1 ready
B> move B:uncontrolled:1 ready
`;

function offersAfter(script: string, seat: string) {
  const run = runScenario(SETUP + script, catalog);
  expect(run.failure).toBeUndefined();
  return availableActions(project(run.state, { kind: 'player', seat }), seat, catalog);
}
const ids = (offers: { id: string }[]) => offers.map((o) => o.id);

describe('available actions (UX-03)', () => {
  it('offers the phase step to the acting player, and only card plays to the others', () => {
    expect(ids(offersAfter('', 'A'))).toEqual(['play', 'advance']);
    expect(ids(offersAfter('', 'B'))).toEqual(['play']);
    const masterPhase = offersAfter('A> next', 'C');
    expect(ids(masterPhase)).toEqual(['play']);
  });

  it('offers actions in the minion phase, filtered by card type', () => {
    const offers = offersAfter('A> next\nA> next', 'A');
    expect(ids(offers)).toEqual(
      expect.arrayContaining(['action:bleed', 'action:hunt', 'action:equip', 'advance']),
    );
    // No ally or retainer in hand, so no recruit or employ.
    expect(ids(offers)).not.toContain('action:recruit');
    // A plain bleed goes to the prey; no Action card in hand, so no card step.
    const bleed = offers.find((o) => o.id === 'action:bleed');
    expect(bleed?.steps.map((s) => s.kind)).toEqual(['card']);
    const minion = bleed?.steps[0];
    const vera = minion?.kind === 'card' ? (minion.candidates[0] ?? '') : '';
    const plain = bleed?.build([vera]);
    expect(plain).toMatchObject({ type: 'DeclareAction', kind: 'bleed', minion: vera });
    expect(plain).not.toHaveProperty('target');
    // Anyone else needs a card effect: the source is optional in casual games.
    const other = offers.find((o) => o.id === 'action:bleed-other');
    expect(other?.steps.map((s) => s.kind)).toEqual(['card', 'card', 'seat']);
    expect(other?.steps[1]).toMatchObject({ optional: true, candidates: [vera] });
    expect(other?.steps[2]).toMatchObject({ candidates: ['C'] });
    expect(other?.build([vera, undefined, 'C'])).toEqual({
      type: 'DeclareAction',
      kind: 'bleed',
      minion: vera,
      target: 'C',
      override: {},
    });
    expect(other?.build([vera, vera, 'C'])).toMatchObject({ override: { source: vera } });
  });

  it('offers a card-effect block to a seat that is not an eligible blocker', () => {
    const script =
      'C> move C:uncontrolled:1 ready\nA> next\nA> next\nA> bleed A:ready:1\nC> hold\nB> pass';
    const offers = offersAfter(script, 'C');
    expect(ids(offers)).toEqual(['block-override', 'play', 'pass']);
    const block = offers[0];
    expect(block?.steps.map((s) => s.kind)).toEqual(['card', 'card']);
    const minion = block?.steps[1];
    const ilse = minion?.kind === 'card' ? (minion.candidates[0] ?? '') : '';
    expect(block?.build([undefined, ilse])).toEqual({
      type: 'Block',
      minion: ilse,
      override: {},
    });
  });

  it('offers block and decline to the impulse holder only, then resolution to the actor', () => {
    const declared = 'A> next\nA> next\nA> bleed A:ready:1';
    expect(ids(offersAfter(declared, 'B'))).toEqual(['block', 'play', 'pass']);
    expect(offersAfter(declared, 'B').find((o) => o.id === 'pass')?.label).toBe('Don’t block');
    expect(offersAfter(declared, 'A')).toEqual([]);
    // Seats without the impulse may only ask the window to wait; the acting seat never needs to.
    const hold = offersAfter(declared, 'C');
    expect(ids(hold)).toEqual(['hold']);
    expect(hold[0]?.build([])).toEqual({ type: 'Hold' });
    expect(offersAfter(`${declared}\nC> hold`, 'C')).toEqual([]);
    const resolving = `${declared}\nB> pass`;
    expect(ids(offersAfter(resolving, 'A'))).toEqual([
      'success',
      'failure',
      'enter-combat',
      'play',
      'pass',
      'cancel',
    ]);
    const success = offersAfter(resolving, 'A').find((o) => o.id === 'success');
    expect(success?.build([3, true])).toEqual({
      type: 'ResolveAction',
      outcome: 'success',
      amount: 3,
      edge: true,
    });
  });

  it('offers ending combat to both players in it', () => {
    const combat =
      'A> next\nA> next\nA> hunt A:ready:1\nB> block B:ready:1\nA> pass\nB> pass\nC> pass';
    expect(ids(offersAfter(combat, 'A'))).toContain('endcombat');
    expect(ids(offersAfter(combat, 'B'))).toContain('endcombat');
    expect(ids(offersAfter(combat, 'C'))).not.toContain('endcombat');
  });
});

describe('combat offers (docs/m6-plan.md M6.4a)', () => {
  const COMBAT =
    'A> next\nA> next\nA> hunt A:ready:1\nB> block B:ready:1\nA> pass\nB> pass\nC> pass';
  const at = (script: string, seat: string) => {
    const run = runScenario(SETUP + script, catalog);
    expect(run.failure).toBeUndefined();
    const view = project(run.state, { kind: 'player', seat });
    return { view, offers: availableActions(view, seat, catalog) };
  };
  const byId = (offers: ReturnType<typeof availableActions>, id: string) => {
    const o = offers.find((x) => x.id === id);
    if (!o) throw new Error(`no offer ${id} in ${offers.map((x) => x.id).join(', ')}`);
    return o;
  };

  it('offers each step’s moves to the combatant holding the impulse, and passes to both', () => {
    const start = at(COMBAT, 'A');
    expect(start.offers.map((o) => o.id)).toEqual([
      'play',
      'use',
      'pass',
      'pass-strikes',
      'endcombat',
    ]);
    expect(at(COMBAT, 'B').offers.map((o) => o.id)).toEqual(['pass-strikes', 'endcombat']);
    // Carol, outside the combat, is polled after the combatants (rules-qa 98.1): she may hold.
    expect(at(COMBAT, 'C').offers.map((o) => o.id)).toEqual(['hold']);
    expect(byId(start.offers, 'pass-strikes').build([])).toEqual({
      type: 'PassUntil',
      until: 'strikes',
    });
    expect(byId(start.offers, 'endcombat').build([])).toEqual({ type: 'EndCombat' });
    const card = start.view.zones['A:ready']?.[0] ?? '';
    expect(byId(start.offers, 'use').build([card, 'note'])).toEqual({
      type: 'UseCard',
      card,
      note: 'note',
    });

    const range = at(`${COMBAT}\nA> pass\nB> pass`, 'A');
    const maneuver = byId(range.offers, 'maneuver');
    expect(maneuver.label).toBe('Maneuver to long…');
    expect(maneuver.build([undefined])).toEqual({ type: 'Maneuver', to: 'long' });
    expect(maneuver.build(['x'])).toEqual({ type: 'Maneuver', to: 'long', source: 'x' });
    // The acting side keeps the impulse, but can't maneuver twice in a row.
    const moved = at(`${COMBAT}\nA> pass\nB> pass\nA> maneuver long`, 'A');
    expect(moved.offers.some((o) => o.id === 'maneuver')).toBe(false);
    expect(moved.offers.some((o) => o.id === 'pass')).toBe(true);
  });

  it('offers the strikes until one is chosen, then the end-of-round pass', () => {
    const strikes = `${COMBAT}\nA> pass strikes\nB> pass strikes`;
    const { offers } = at(strikes, 'A');
    expect(offers.some((o) => o.id === 'pass')).toBe(false);
    expect(byId(offers, 'strike:hand').build([2])).toEqual({
      type: 'Strike',
      kind: 'hand',
      amount: 2,
    });
    expect(byId(offers, 'strike:damage').build(['w', 3, 'RA', true])).toEqual({
      type: 'Strike',
      kind: 'damage',
      source: 'w',
      amount: 3,
      ranged: true,
      aggravated: true,
      first: true,
    });
    expect(byId(offers, 'strike:dodge').build([undefined])).toEqual({
      type: 'Strike',
      kind: 'dodge',
    });
    expect(byId(offers, 'strike:combat-ends').build(['c'])).toEqual({
      type: 'Strike',
      kind: 'combat-ends',
      source: 'c',
    });
    expect(byId(offers, 'strike:steal-blood').build([undefined, 2])).toEqual({
      type: 'Strike',
      kind: 'steal-blood',
      amount: 2,
    });
    expect(byId(offers, 'strike:none').build([])).toEqual({ type: 'Strike', kind: 'none' });

    const damage = at(`${strikes}\nA> strike hand\nB> strike none`, 'B');
    expect(byId(damage.offers, 'pass-end').build([])).toEqual({ type: 'PassUntil', until: 'end' });
  });

  it('offers prevention to whoever is about to take damage, additional strikes, and presses', () => {
    const strikes = `${COMBAT}\nA> pass strikes\nB> pass strikes`;
    const damage = `${strikes}\nA> strike 2\nB> strike none\nA> pass`;
    const b = at(damage, 'B');
    const prevent = byId(b.offers, 'prevent');
    expect(prevent.steps[0]).toMatchObject({ kind: 'amount', default: 2 });
    expect(prevent.build([1, undefined])).toEqual({ type: 'Prevent', points: 1 });
    expect(prevent.build([2, 'c'])).toEqual({ type: 'Prevent', points: 2, source: 'c' });
    expect(byId(b.offers, 'additional').build(['c'])).toEqual({
      type: 'AdditionalStrike',
      source: 'c',
    });
    // A takes no damage: nothing to prevent.
    const a = at(`${strikes}\nA> strike 2\nB> strike none`, 'A');
    expect(a.offers.some((o) => o.id === 'prevent')).toBe(false);
    expect(byId(a.offers, 'additional').build([undefined])).toEqual({ type: 'AdditionalStrike' });

    // B's blood-less vampire goes to torpor: the combat ends, with no presses.
    const torpor = at(`${damage}\nB> pass\nA> pass`, 'A');
    expect(torpor.view.action?.combat?.step).toBe('end-of-round');

    const press = at(`${strikes}\nA> strike none\nB> strike none\nA> pass\nB> pass`, 'A');
    expect(press.view.action?.combat?.step).toBe('press');
    expect(byId(press.offers, 'press:continue').build([undefined])).toEqual({
      type: 'Press',
      mode: 'continue',
    });
    expect(byId(press.offers, 'press:end').build(['p'])).toEqual({
      type: 'Press',
      mode: 'end',
      source: 'p',
    });
    // Pressed last: no press until the other side answers.
    const pressed = at(
      `${strikes}\nA> strike none\nB> strike none\nA> pass\nB> pass\nA> press continue`,
      'A',
    );
    expect(pressed.offers.some((o) => o.id.startsWith('press:'))).toBe(false);
  });

  it('offers entering combat when resolving an action', () => {
    const resolving = 'A> next\nA> next\nA> action A:ready:1\nB> pass\nC> pass';
    const { view, offers } = at(resolving, 'A');
    const opponent = view.zones['B:ready']?.[0] ?? '';
    expect(byId(offers, 'enter-combat').build([opponent])).toEqual({
      type: 'ResolveAction',
      outcome: 'combat',
      opponent,
    });
  });
});
