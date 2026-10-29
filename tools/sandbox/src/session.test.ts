import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CardInfo, createCatalog, runScenario } from '@torn-signpost/engine';
import { describe, expect, it } from 'vitest';
import { defaultSetup, Session } from './session.ts';

const catalog = createCatalog(
  (
    JSON.parse(
      readFileSync(
        join(import.meta.dirname, '../../../packages/engine/scenarios/catalog.json'),
        'utf8',
      ),
    ) as { cards: CardInfo[] }
  ).cards,
);

describe('sandbox session', () => {
  it('plays commands as the current seat and logs them from that seat’s view', () => {
    const s = new Session(defaultSetup(1), catalog);
    expect(s.execute('transfer +2 unc:1')).toEqual([
      "A moved 2 blood from A's pool to Vera Nightfall",
    ]);
    s.execute('.as B');
    expect(s.execute('.log 1')).toEqual(["A moved 2 blood from A's pool to a card"]);
    expect(s.execute('move A:hand:1 ash')).toEqual([
      expect.stringMatching(/another player's hidden zone/),
    ]);
  });

  it('hides other seats’ hands in the table view', () => {
    const s = new Session(defaultSetup(1), catalog);
    s.execute('.as B');
    const view = s.view().join('\n');
    expect(view).toContain('hand: 7 hidden');
    expect(view).toContain('hand:1  ');
  });

  it('undoes, and saves a script that replays to the same state', () => {
    const s = new Session(defaultSetup(2), catalog);
    s.execute('pool -1');
    s.execute('pool -1');
    expect(s.execute('.undo')).toEqual(['Undid: A> pool -1']);
    expect(runScenario(s.script, catalog).state).toEqual(s.state);
    expect(s.state.seats[0]?.pool).toBe(29);
  });

  it('completes card names for the current seat', () => {
    const s = new Session(defaultSetup(1), catalog);
    expect(s.complete('lock "Ver')).toEqual([['"Vera Nightfall"'], '"Ver']);
  });
});
