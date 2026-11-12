import type { JudgeQueueEntry } from '@torn-signpost/protocol';
import { describe, expect, it } from 'vitest';
import { ANY, filterQueue } from './JudgePage.tsx';

const entry = (
  id: string,
  reason: JudgeQueueEntry['call']['reason'],
  tournament: boolean,
  claimedBy?: string,
): JudgeQueueEntry => ({
  gameId: `g-${id}`,
  gameName: id,
  tournament,
  call: {
    id,
    reason,
    openedAt: '2026-11-01T10:00:00Z',
    ...(claimedBy ? { claimedBy } : {}),
  } as JudgeQueueEntry['call'],
});

const queue = [
  entry('a', 'rules', false),
  entry('b', 'slow-play', true, 'jo'),
  entry('c', 'deadline', true),
  entry('d', 'rules', false, 'kim'),
];
const ids = (f: Partial<typeof ANY>) =>
  filterQueue(queue, { ...ANY, ...f }, 'jo').map((e) => e.gameName);

describe('judge queue filters (M5b leftovers)', () => {
  it('shows everything by default', () => {
    expect(ids({})).toEqual(['a', 'b', 'c', 'd']);
  });
  it('filters by claim', () => {
    expect(ids({ status: 'unclaimed' })).toEqual(['a', 'c']);
    expect(ids({ status: 'mine' })).toEqual(['b']);
    expect(ids({ status: 'others' })).toEqual(['d']);
  });
  it('filters by tournament or casual', () => {
    expect(ids({ kind: 'tournament' })).toEqual(['b', 'c']);
    expect(ids({ kind: 'casual' })).toEqual(['a', 'd']);
  });
  it('combines filters', () => {
    expect(ids({ reason: 'rules', status: 'unclaimed', kind: 'casual' })).toEqual(['a']);
    expect(ids({ reason: 'rules', kind: 'tournament' })).toEqual([]);
  });
});
