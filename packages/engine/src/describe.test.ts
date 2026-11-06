import { describe, expect, it } from 'vitest';
import { combatStepLabel, describeEvent, strikeText } from './describe.ts';
import type { GameEvent } from './events.ts';
import { runScenario } from './scenario.ts';
import { testCatalog } from './testing/fixtures.ts';

describe('event descriptions', () => {
  const run = runScenario('seat A a\nseat B b\nseat C c\nstart', testCatalog);
  const event = (cardId: string): GameEvent => ({
    type: 'CardRevealed',
    card: 'c1',
    cardId,
    seq: run.state.seq + 1,
    at: '2026-11-03T00:00:00.000Z',
    by: { kind: 'seat', seat: 'A' },
  });

  it('names cards from the catalog', () => {
    expect(describeEvent(event('t-signal'), run.state, { catalog: testCatalog })).toBe(
      'A revealed Signal Fire',
    );
  });

  it('says when a known card is missing from the card data, instead of calling it hidden', () => {
    expect(describeEvent(event('x-missing'), run.state, { catalog: testCatalog })).toBe(
      'A revealed an unknown card (x-missing)',
    );
  });
});

describe('combat in the log (M6.4a)', () => {
  it('says what a strike does, as printed on cards', () => {
    expect(strikeText({ kind: 'damage', amount: 2, ranged: true })).toBe('2R damage');
    expect(strikeText({ kind: 'damage', amount: 1, aggravated: true, first: true })).toBe(
      '1 aggravated damage, first strike',
    );
    expect(strikeText({ kind: 'hand' })).toBe('a hand strike for 1');
    expect(strikeText({ kind: 'steal-blood', amount: 2, ranged: true })).toBe(
      'steal 2 blood, ranged',
    );
    expect(strikeText({ kind: 'combat-ends', note: 'Hidden Lurker' })).toBe(
      'combat ends (“Hidden Lurker”)',
    );
    expect(strikeText({ kind: 'other', note: 'Destroys equipment' })).toBe('Destroys equipment');
    expect(strikeText({ kind: 'other' })).toBe('a strike');
    expect(combatStepLabel({ round: 2, step: 'before-strikes' })).toBe('Round 2 · Before strikes');
  });
});
