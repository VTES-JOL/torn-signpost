import { describe, expect, it } from 'vitest';
import { seatLayout } from './seatLayout.ts';

const grid = (clockwise: string[], prey?: string, predator?: string) => {
  const { columns, placements } = seatLayout(clockwise, prey, predator);
  const rows = Math.max(...placements.map((p) => p.row));
  return Array.from({ length: rows }, (_, r) =>
    Array.from(
      { length: columns },
      (_, c) => placements.find((p) => p.row === r + 1 && p.column === c + 1)?.seat ?? '.',
    ).join(' '),
  );
};

describe('seat layout', () => {
  it('puts prey on the left, predator on the right, the rest across the table', () => {
    // Seat 4 of five: clockwise 5, 1, 2, 3; prey 5, predator 3.
    expect(grid(['5', '1', '2', '3'], '5', '3')).toEqual(['1 2', '5 3']);
    expect(grid(['B', 'C', 'D', 'E', 'F'], 'B', 'F')).toEqual(['C D E', 'B . F']);
  });

  it('uses one row when at most one seat is across the table', () => {
    expect(grid(['B', 'C', 'D'], 'B', 'D')).toEqual(['B C D']);
    expect(grid(['B', 'C'], 'B', 'C')).toEqual(['B C']);
    expect(grid(['B'], 'B', 'B')).toEqual(['B']);
  });

  it('keeps ousted seats across the table in clockwise order', () => {
    // C was ousted: prey is now D.
    expect(grid(['C', 'D', 'E', 'F'], 'D', 'F')).toEqual(['C E', 'D F']);
  });

  it('lists placements in clockwise reading order', () => {
    const { placements } = seatLayout(['5', '1', '2', '3'], '5', '3');
    expect(placements.map((p) => p.seat)).toEqual(['5', '1', '2', '3']);
  });
});
