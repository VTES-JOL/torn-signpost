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
A> draw crypt
A> move A:uncontrolled:1 ready
A> draw 7
B> draw crypt
B> move B:uncontrolled:1 ready
B> draw 7
C> draw 7
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
      'C> draw crypt\nC> move C:uncontrolled:1 ready\nA> next\nA> next\nA> bleed "Vera Nightfall"\nC> hold\nB> pass';
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
    const declared = 'A> next\nA> next\nA> bleed "Vera Nightfall"';
    expect(ids(offersAfter(declared, 'B'))).toEqual(['block', 'play', 'pass']);
    expect(offersAfter(declared, 'B').find((o) => o.id === 'pass')?.label).toBe('Don’t block');
    expect(offersAfter(declared, 'A')).toEqual([]);
    // Seats without the impulse may only ask the window to wait; the acting seat never needs to.
    const hold = offersAfter(declared, 'C');
    expect(ids(hold)).toEqual(['hold']);
    expect(hold[0]?.build([])).toEqual({ type: 'Hold' });
    expect(offersAfter(`${declared}\nC> hold`, 'C')).toEqual([]);
    const resolving = `${declared}\nB> pass`;
    expect(ids(offersAfter(resolving, 'A'))).toEqual(['success', 'failure', 'play', 'cancel']);
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
      'A> next\nA> next\nA> hunt "Vera Nightfall"\nB> block "Tomas Grey"\nA> pass\nB> pass\nC> pass';
    expect(ids(offersAfter(combat, 'A'))).toContain('endcombat');
    expect(ids(offersAfter(combat, 'B'))).toContain('endcombat');
    expect(ids(offersAfter(combat, 'C'))).not.toContain('endcombat');
  });
});
