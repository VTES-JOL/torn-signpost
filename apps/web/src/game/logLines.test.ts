/** Log lines: the same change in a row reads as one line with the total. */
import type { GameEvent } from '@torn-signpost/engine';
import { describe, expect, it } from 'vitest';
import { type LogLine, logLine, mergeRuns } from './client.ts';

let seq = 0;
const at = '2026-01-01T00:00:00.000Z';
const pool = (delta: number, seat = 'B'): LogLine =>
  logLine(
    { seq: ++seq, at, type: 'PoolAdjusted', seat, delta } as GameEvent,
    `Bob: ${seat === 'B' ? 'Bob' : 'Carol'}'s pool ${delta > 0 ? `+${delta}` : delta}`,
  );
const chat = { text: 'Carol: nice' };

describe('log lines', () => {
  it('merge a run of the same change into one line with the total', () => {
    const lines = mergeRuns([pool(-1), pool(-1), pool(-1), pool(+1)]);
    expect(lines.map((l) => l.text)).toEqual(["Bob: Bob's pool -2"]);
  });

  it('show a run that cancels out as ±0', () => {
    expect(mergeRuns([pool(+1), pool(-1)]).map((l) => l.text)).toEqual(["Bob: Bob's pool ±0"]);
  });

  it('end a run at anything else: another seat, a chat message, another event', () => {
    const other = logLine(
      { seq: ++seq, at, type: 'PhaseAdvanced', turn: { phase: 'minion' } } as unknown as GameEvent,
      "Bob's minion phase",
    );
    const lines = mergeRuns<{ text: string; change?: LogLine['change'] }>([
      pool(-1),
      pool(-1, 'C'),
      pool(-1, 'C'),
      chat,
      pool(-1, 'C'),
      other,
      pool(-1, 'C'),
    ]);
    expect(lines.map((l) => l.text)).toEqual([
      "Bob: Bob's pool -1",
      "Bob: Carol's pool -2",
      'Carol: nice',
      "Bob: Carol's pool -1",
      "Bob's minion phase",
      "Bob: Carol's pool -1",
    ]);
  });

  it('only merge changes by an amount', () => {
    expect(pool(-1).change).toMatchObject({ delta: -1, before: "Bob: Bob's pool " });
    const moved = logLine(
      { seq: ++seq, at, type: 'CardMoved' } as unknown as GameEvent,
      'Bob moved a card',
    );
    expect(moved.change).toBeUndefined();
  });
});
