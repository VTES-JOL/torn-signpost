import { describe, expect, it } from 'vitest';
import { describeEvent } from './describe.ts';
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
