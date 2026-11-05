/**
 * The table timer and pauses (TEMPO-03/05) in the flow bar: time left (or played, without a time
 * limit), why the clock is stopped, and pausing for a few minutes. The clock is computed from the
 * game state and the local time, so it ticks without messages from the server.
 */
import {
  clockElapsed,
  clockRemaining,
  clockRunning,
  type GameState,
  MAX_PAUSE_MINUTES,
} from '@torn-signpost/engine';
import type { PlayerCommand } from '@torn-signpost/protocol';
import { useEffect, useState } from 'react';

/** The current time, updated every `ms` milliseconds. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** 1:05:09, or 5:09 under an hour. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** "23 h", "45 min" or "under a minute": for deadlines, which are hours long. */
export function formatLeft(ms: number): string {
  if (ms >= 3_600_000) return `${Math.floor(ms / 3_600_000)} h`;
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)} min`;
  return 'under a minute';
}

export function Clock(props: {
  view: GameState;
  seat: string | undefined;
  judge: boolean;
  seatName: (seat: string) => string;
  send: (command: PlayerCommand) => void;
}) {
  const { view, seat, judge, seatName, send } = props;
  const now = useNow();
  const [minutes, setMinutes] = useState(MAX_PAUSE_MINUTES);
  if (view.status !== 'active' || !view.clock) return null;
  const at = new Date(now).toISOString();
  const remaining = clockRemaining(view, at);
  const time =
    remaining === undefined
      ? `${formatClock(clockElapsed(view, at))} played`
      : `${formatClock(remaining)} left`;
  const pause = view.pause;
  const status = view.clock.limitReachedAt
    ? 'time is up'
    : pause
      ? `paused by ${pause.seat ? seatName(pause.seat) : 'a judge'} · ${formatClock(Date.parse(pause.until) - now)}`
      : clockRunning(view)
        ? undefined
        : 'paused: waiting for players to return';
  const canPause = view.settings.timeLimitMs !== undefined && (seat !== undefined || judge);
  const canResume = !!pause && (judge || (seat !== undefined && pause.seat === seat));
  return (
    <span className="clock small">
      <span className={`clock-time ${remaining !== undefined && remaining < 600_000 ? 'low' : ''}`}>
        {time}
      </span>
      {status && <span className="muted">{status}</span>}
      {canResume && (
        <button type="button" onClick={() => send({ type: 'Resume' })}>
          Resume
        </button>
      )}
      {canPause && !pause && (
        <>
          <select
            aria-label="Pause length"
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          >
            {Array.from({ length: MAX_PAUSE_MINUTES }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
          <button type="button" onClick={() => send({ type: 'Pause', minutes })}>
            Pause
          </button>
        </>
      )}
    </span>
  );
}
