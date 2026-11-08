import { describe, expect, it } from 'vitest';
import { combatEndsStruck, damageTaken, isVampire, pendingFrom } from './combat.ts';
import type { CardInstance, CombatState, PendingDamage, Strike } from './model.ts';
import { testCatalog as catalog } from './testing/fixtures.ts';

const fight = (
  strikes: [string, Strike][],
  range: CombatState['range'] = 'close',
): CombatState => ({
  cause: 'block',
  acting: 'a',
  opposing: 'o',
  round: 1,
  step: 'strikes',
  range,
  strikes: strikes.map(([minion, strike]) => ({ minion, strike })),
});

describe('which strikes land (M6.4b)', () => {
  it('lands both strikes at once, on the other combatant', () => {
    const c = fight([
      ['a', { kind: 'hand', amount: 2 }],
      ['o', { kind: 'damage', amount: 1, aggravated: true }],
    ]);
    expect(pendingFrom(c)).toEqual({
      pending: {
        o: { by: 'a', normal: 2, aggravated: 0, prevented: 0 },
        a: { by: 'o', normal: 0, aggravated: 1, prevented: 0 },
      },
      later: false,
    });
  });

  it('lets a dodge cancel the strike against the dodger, and long range stop close strikes', () => {
    const dodged = fight([
      ['a', { kind: 'hand', amount: 2 }],
      ['o', { kind: 'dodge' }],
    ]);
    expect(pendingFrom(dodged).pending).toEqual({});
    const long = fight(
      [
        ['a', { kind: 'hand' }],
        ['o', { kind: 'damage', amount: 2, ranged: true }],
      ],
      'long',
    );
    expect(pendingFrom(long).pending).toEqual({
      a: { by: 'o', normal: 2, aggravated: 0, prevented: 0 },
    });
  });

  it('resolves first strikes first, when other strikes follow', () => {
    const c = fight([
      ['a', { kind: 'hand', first: true }],
      ['o', { kind: 'steal-blood', amount: 2 }],
    ]);
    expect(pendingFrom(c)).toEqual({
      pending: { o: { by: 'a', normal: 1, aggravated: 0, prevented: 0 } },
      later: true,
    });
    expect(pendingFrom(c, 'normal').pending).toEqual({
      a: { by: 'o', normal: 0, aggravated: 0, prevented: 0, stolen: 2 },
    });
    // Only first strikes: nothing to split.
    expect(pendingFrom(fight([['a', { kind: 'hand', first: true }]])).later).toBe(false);
  });

  it('knows when combat ends was struck, and ignores strikes that do nothing', () => {
    expect(combatEndsStruck(fight([['o', { kind: 'combat-ends' }]]))).toBe(true);
    expect(combatEndsStruck(fight([['o', { kind: 'dodge' }]]))).toBe(false);
    const none = fight([
      ['a', { kind: 'none' }],
      ['o', { kind: 'other', note: 'x' }],
      ['o', { kind: 'hand', amount: 0 }],
    ]);
    expect(pendingFrom(none).pending).toEqual({});
  });
});

describe('taking damage (M6.4b, C5)', () => {
  const card = (cardId: string, counters: CardInstance['counters']): CardInstance => ({
    id: 'x',
    cardId,
    owner: 'A',
    controller: 'A',
    zone: 'A:ready',
    locked: false,
    faceDown: false,
    contested: false,
    counters,
  });
  const vampire = (blood: number) => card('t-vera', { blood });
  const hit = (normal: number, aggravated = 0, prevented = 0): PendingDamage => ({
    by: 'y',
    normal,
    aggravated,
    prevented,
  });

  it('mends normal damage with blood, and goes to torpor with what it can’t mend', () => {
    expect(damageTaken(vampire(3), hit(2), catalog)).toMatchObject({
      damage: 2,
      blood: 2,
      outcome: 'mended',
    });
    expect(damageTaken(vampire(1), hit(2), catalog)).toMatchObject({
      blood: 1,
      outcome: 'torpor',
    });
    expect(damageTaken(vampire(1), hit(2, 0, 2), catalog)).toMatchObject({ outcome: 'unhurt' });
  });

  it('can’t mend aggravated damage: it wounds, then costs blood, or burns', () => {
    // One point wounds an unwounded vampire: torpor, no blood.
    expect(damageTaken(vampire(3), hit(0, 1), catalog)).toMatchObject({
      blood: 0,
      outcome: 'torpor',
    });
    // Wounded by the first, the next two cost a blood each.
    expect(damageTaken(vampire(3), hit(0, 3), catalog)).toMatchObject({
      blood: 2,
      outcome: 'torpor',
    });
    // Normal damage left unmended wounds first, so every aggravated point costs blood.
    expect(damageTaken(vampire(1), hit(2, 1), catalog)).toMatchObject({ outcome: 'burned' });
    // Prevention comes off aggravated damage first.
    expect(damageTaken(vampire(2), hit(1, 1, 1), catalog)).toMatchObject({
      damage: 1,
      aggravated: 0,
      outcome: 'mended',
    });
  });

  it('takes an ally’s life, aggravated or not, and burns it at 0', () => {
    const ally = card('t-feed', { life: 3 });
    expect(isVampire(ally, catalog)).toBe(false);
    expect(damageTaken(ally, hit(1, 1), catalog)).toMatchObject({ life: 2, outcome: 'hurt' });
    expect(damageTaken(ally, hit(3), catalog)).toMatchObject({ life: 3, outcome: 'burned' });
    expect(damageTaken(ally, hit(0), catalog)).toMatchObject({ outcome: 'unhurt' });
    // Without card data, life counters mean an ally.
    expect(isVampire(card('unknown', { life: 1 }), catalog)).toBe(false);
    expect(isVampire(card('unknown', {}), catalog)).toBe(true);
  });
});
