import { describe, expect, it } from 'vitest';
import { formatClock, formatLeft } from './Clock.tsx';

describe('clock formatting', () => {
  it('shows hours only when there are some', () => {
    expect(formatClock(2 * 3_600_000)).toBe('2:00:00');
    expect(formatClock(3_600_000 + 65_000)).toBe('1:01:05');
    expect(formatClock(309_000)).toBe('5:09');
    expect(formatClock(-5)).toBe('0:00');
  });

  it('rounds deadlines down to hours or minutes', () => {
    expect(formatLeft(23.5 * 3_600_000)).toBe('23 h');
    expect(formatLeft(45 * 60_000 + 10)).toBe('45 min');
    expect(formatLeft(5_000)).toBe('under a minute');
  });
});
