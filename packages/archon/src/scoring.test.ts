/**
 * VEKN Tournament Rules 3.7.4's worked examples (vekn.net/tournament-rules, read 2026-11-15), and
 * the 4-player table the spike scored on archon.krcg.org (docs/m7-plan.md).
 */
import { describe, expect, it } from 'vitest';
import { plausibleTable, tableResults, tableSizes } from './scoring.ts';

describe('table scoring (3.7)', () => {
  it('3.7.4 example 1: five players, A and C tie on 1½, E has ½', () => {
    // A, B, C, D, E: A and C oust one prey each and survive with E.
    expect(tableResults([1.5, 0, 1.5, 0, 0.5])).toEqual([
      { gw: 0, tp: 54 },
      { gw: 0, tp: 18 },
      { gw: 0, tp: 54 },
      { gw: 0, tp: 18 },
      { gw: 0, tp: 36 },
    ]);
  });

  it('3.7.4 example 2: four players, A has 1½, C and D ½ each', () => {
    // 2nd and 3rd place on a 4-player table share 48 and 24 (3rd is the table bye's).
    expect(tableResults([1.5, 0, 0.5, 0.5])).toEqual([
      { gw: 0, tp: 60 },
      { gw: 0, tp: 12 },
      { gw: 0, tp: 36 },
      { gw: 0, tp: 36 },
    ]);
  });

  it('the spike table: 2½, 0, 0, ½ on four (archon.krcg.org, 2026-11-15)', () => {
    expect(tableResults([2.5, 0, 0, 0.5])).toEqual([
      { gw: 1, tp: 60 },
      { gw: 0, tp: 18 },
      { gw: 0, tp: 18 },
      { gw: 0, tp: 48 },
    ]);
  });

  it('gives no game win on a tie, or under 2 VP (3.7.1)', () => {
    expect(tableResults([2, 2, 0, 0, 1]).map((r) => r.gw)).toEqual([0, 0, 0, 0, 0]);
    expect(tableResults([1.5, 1, 0.5, 0, 0]).map((r) => r.gw)).toEqual([0, 0, 0, 0, 0]);
    expect(tableResults([3, 1, 0.5, 0.5, 0]).map((r) => r.gw)).toEqual([1, 0, 0, 0, 0]);
  });

  it('always shares out the same points: 180 at five, 144 at four', () => {
    const sum = (vps: number[]) => tableResults(vps).reduce((a, r) => a + r.tp, 0);
    expect(sum([1, 1, 1, 1, 1])).toBe(180);
    expect(sum([0, 0, 0, 0])).toBe(144);
    expect(sum([2, 0.5, 0.5, 0, 0])).toBe(180);
  });

  it('flags a table that couldn’t have scored that', () => {
    expect(plausibleTable([2, 2, 2, 2])).toBe(false);
    expect(plausibleTable([2.5, 0, 0, 0.5])).toBe(true);
    expect(plausibleTable([0.3, 0, 0, 0])).toBe(false);
  });

  it('seats as many tables of 5 as possible, the rest of 4 (3.1.2)', () => {
    expect(tableSizes(4)).toEqual([4]);
    expect(tableSizes(9)).toEqual([5, 4]);
    expect(tableSizes(12)).toEqual([4, 4, 4]);
    expect(tableSizes(13)).toEqual([5, 4, 4]);
    for (const n of [3, 6, 7, 11]) expect(tableSizes(n)).toBeUndefined();
  });
});
