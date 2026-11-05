/**
 * Time at the table (TEMPO-03/04/05, docs/m5b-plan.md increment 3): the table clock, pauses and
 * async deadlines. Time comes only from event timestamps (`at`), so replays reproduce it exactly;
 * the engine decides when things are due, and the server only schedules a check for then
 * (`timers`). A check that fires early, late or twice does nothing wrong.
 */
import type { Command } from './commands.ts';
import { tempo, type WaitKind, waitingOn } from './flow.ts';
import type { GameState, Instant } from './model.ts';
import type { SeatId } from './seating.ts';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
/** How long a player who is away has for a decision, unless the game says otherwise. */
export const DEFAULT_DEADLINE_MS = 24 * HOUR_MS;
/** Tournament rounds last at least two hours (Tournament Rules 3.1.1). */
export const MIN_TOURNAMENT_TIME_LIMIT_MS = 2 * HOUR_MS;
/** A pause asked for by a player lasts at most this long; they can pause again afterwards. */
export const MAX_PAUSE_MINUTES = 5;

/** Milliseconds since the epoch, or NaN for a timestamp that isn't one (some tests use 't'). */
export const ms = (at: Instant | undefined): number =>
  at === undefined ? Number.NaN : Date.parse(at);
const iso = (n: number): Instant => new Date(n).toISOString();

/**
 * Whether the table clock is running: the game is in progress, no judge call is open, live
 * (everyone still in it is at
 * the table), and not paused. In async play the clock waits (DQ7).
 */
export function clockRunning(state: GameState): boolean {
  return (
    state.status === 'active' &&
    !state.pause &&
    !state.judgeCalls?.length &&
    tempo(state) === 'live'
  );
}

/** The time limit including any time judges added, if the game has one. */
export function timeLimit(state: GameState): number | undefined {
  const limit = state.settings.timeLimitMs;
  return limit === undefined ? undefined : limit + (state.clock?.extendedMs ?? 0);
}

/** Time played so far at `now`, counting only while the clock runs. */
export function clockElapsed(state: GameState, now: Instant): number {
  const c = state.clock;
  if (!c) return 0;
  const since = ms(c.runningSince);
  const extra = Number.isNaN(since) || Number.isNaN(ms(now)) ? 0 : Math.max(0, ms(now) - since);
  return c.elapsedMs + extra;
}

/** Time left before the time limit at `now`, if the game has one. */
export function clockRemaining(state: GameState, now: Instant): number | undefined {
  const limit = timeLimit(state);
  return limit === undefined ? undefined : Math.max(0, limit - clockElapsed(state, now));
}

export interface Deadline {
  seat: SeatId;
  kind: WaitKind;
  /** When the reminder goes out: halfway. */
  remindAt: Instant;
  dueAt: Instant;
  reminded: boolean;
  expired: boolean;
}

/**
 * One deadline per decision the game waits on from a player who is away (TEMPO-04), counted from
 * when the wait began or the player left, whichever is later. A player at the table has none.
 */
export function deadlines(state: GameState): Deadline[] {
  const w = state.waiting;
  if (state.status !== 'active' || !w) return [];
  const span = state.settings.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const out: Deadline[] = [];
  for (const wait of waitingOn(state)) {
    const seat = state.seats.find((s) => s.id === wait.seat);
    if (!seat || seat.present) continue;
    const from = Math.max(ms(w.at), ms(seat.awaySince)) + (w.extendedMs?.[wait.seat] ?? 0);
    if (Number.isNaN(from)) continue;
    out.push({
      seat: wait.seat,
      kind: wait.kind,
      remindAt: iso(from + span / 2),
      dueAt: iso(from + span),
      reminded: !!w.reminded?.includes(wait.seat),
      expired: !!w.expired?.includes(wait.seat),
    });
  }
  return out;
}

/** A system check the server should run at `at`; scheduling the same key again moves it. */
export interface Timer {
  key: string;
  at: Instant;
  command: Extract<Command, { type: 'CheckDeadline' | 'CheckTimeLimit' | 'EndPause' }>;
}

/**
 * Every check the game needs scheduled now: deadline reminders and expiries, the time limit while
 * the clock runs, and the end of a pause. The server compares this before and after each command
 * and creates, moves or cancels its timers to match.
 */
export function timers(state: GameState, opts: { deadlines?: boolean } = {}): Timer[] {
  if (state.status !== 'active') return [];
  const out: Timer[] = [];
  if (opts.deadlines !== false) {
    for (const d of deadlines(state)) {
      if (d.expired) continue;
      out.push({
        key: `deadline:${d.seat}`,
        at: d.reminded ? d.dueAt : d.remindAt,
        command: { type: 'CheckDeadline', seat: d.seat },
      });
    }
  }
  const limit = timeLimit(state);
  const c = state.clock;
  if (limit !== undefined && c?.runningSince && !c.limitReachedAt) {
    const at = ms(c.runningSince) + Math.max(0, limit - c.elapsedMs);
    if (!Number.isNaN(at))
      out.push({ key: 'clock', at: iso(at), command: { type: 'CheckTimeLimit' } });
  }
  if (state.pause) out.push({ key: 'pause', at: state.pause.until, command: { type: 'EndPause' } });
  return out;
}

export { iso as instantFromMs };
