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
    const bleed = offers.find((o) => o.id === 'action:bleed');
    expect(bleed?.steps.map((s) => s.kind)).toEqual(['card', 'seat']);
    expect(bleed?.steps[1]).toMatchObject({ default: 'B', candidates: ['B', 'C'] });
    const minion = bleed?.steps[0];
    expect(bleed?.build([minion?.kind === 'card' ? minion.candidates[0] : '', 'C'])).toMatchObject({
      type: 'DeclareAction',
      kind: 'bleed',
      target: 'C',
    });
  });

  it('offers block and decline to the impulse holder only, then resolution to the actor', () => {
    const declared = 'A> next\nA> next\nA> bleed "Vera Nightfall"';
    expect(ids(offersAfter(declared, 'B'))).toEqual(['block', 'play', 'pass']);
    expect(offersAfter(declared, 'B').find((o) => o.id === 'pass')?.label).toBe('Don’t block');
    expect(offersAfter(declared, 'A')).toEqual([]);
    expect(offersAfter(declared, 'C')).toEqual([]);
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
