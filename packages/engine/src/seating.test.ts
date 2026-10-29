import { describe, expect, it } from 'vitest';
import { liveSeats, nextTurnSeat, predator, prey, type SeatRef, windowOrder } from './seating.ts';

const table = (ousted: string[] = []): SeatRef[] =>
  ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, ousted: ousted.includes(id) }));

describe('predator/prey', () => {
  it('prey is to the left (clockwise), predator to the right', () => {
    expect(prey(table(), 'a')).toBe('b');
    expect(predator(table(), 'a')).toBe('e');
    expect(prey(table(), 'e')).toBe('a');
  });

  it('is recalculated from physical seating when a Methuselah is ousted', () => {
    const t = table(['b']);
    expect(prey(t, 'a')).toBe('c');
    expect(predator(t, 'c')).toBe('a');
    expect(liveSeats(t)).toEqual(['a', 'c', 'd', 'e']);
  });

  it('has no prey or predator when only one seat remains', () => {
    const t = table(['b', 'c', 'd', 'e']);
    expect(prey(t, 'a')).toBeUndefined();
    expect(predator(t, 'a')).toBeUndefined();
  });

  it('prey and predator are the same seat with two left', () => {
    const t = table(['b', 'd', 'e']);
    expect(prey(t, 'a')).toBe('c');
    expect(predator(t, 'a')).toBe('c');
  });
});

describe('nextTurnSeat', () => {
  it('passes to the prey normally and to the predator when reversed', () => {
    expect(nextTurnSeat(table(), 'c', 'toPrey')).toBe('d');
    expect(nextTurnSeat(table(), 'c', 'toPredator')).toBe('b');
  });

  it('continues from the physical position of a seat ousted on its own turn', () => {
    const t = table(['c']);
    expect(nextTurnSeat(t, 'c', 'toPrey')).toBe('d');
    expect(nextTurnSeat(t, 'c', 'toPredator')).toBe('b');
  });
});

describe('windowOrder', () => {
  it('undirected: acting, prey, predator, then the rest clockwise', () => {
    expect(windowOrder(table(), 'c', 'undirected')).toEqual(['c', 'd', 'b', 'e', 'a']);
  });

  it('directed: acting, target, then the rest clockwise', () => {
    expect(windowOrder(table(), 'a', { directedAt: 'd' })).toEqual(['a', 'd', 'b', 'c', 'e']);
  });

  it('skips ousted seats', () => {
    expect(windowOrder(table(['d']), 'c', 'undirected')).toEqual(['c', 'e', 'b', 'a']);
  });
});
