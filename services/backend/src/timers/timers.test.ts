import { afterEach, describe, expect, it, vi } from 'vitest';
import { localTimers, presenceKey, scheduleName, type TimerPayload } from './timers.ts';

describe('timers', () => {
  afterEach(() => vi.useRealTimers());

  it('fires local timers once, and rescheduling a key moves it', async () => {
    vi.useFakeTimers({ now: 0 });
    const fired: TimerPayload[] = [];
    const timers = localTimers(() => async (p) => void fired.push(p));
    const payload: TimerPayload = { kind: 'presence', gameId: 'g', user: 'u' };
    await timers.schedule('k', new Date(30_000), payload);
    await vi.advanceTimersByTimeAsync(20_000);
    await timers.schedule('k', new Date(50_000), payload);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fired).toEqual([payload]);
    expect(timers.pending()).toBe(0);
    await timers.schedule('k', new Date(60_000), payload);
    await timers.cancel('k');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toHaveLength(1);
  });

  it('makes schedule names that fit EventBridge Scheduler', () => {
    const name = scheduleName(presenceKey('AbC123xyz_-9', 'Google_1234567890:weird/user'));
    expect(name).toMatch(/^presence-[0-9a-f]{40}$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(scheduleName(presenceKey('g', 'a'))).not.toBe(scheduleName(presenceKey('g', 'b')));
  });
});
