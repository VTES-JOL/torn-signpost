/**
 * A game as a sequence of steps over its event log: the common ground of scenario playback in
 * the browser and, later, recording and replaying real games (GAME-17). A scenario's steps are
 * its script lines; a recorded game's steps are the commands that produced its events.
 *
 * Steps only index into `events`, so a timeline is plain data: states are rebuilt with `evolve`
 * and redacted per viewer with `project`/`projectEvent`, as everywhere else.
 */
import type { GameEvent } from './events.ts';
import { evolve, newGame } from './evolve.ts';
import type { GameState } from './model.ts';

export type TimelineStepKind = 'setup' | 'command' | 'check';

export interface TimelineStep {
  kind: TimelineStepKind;
  /** What the step was: a script line, or a description of the command. */
  text: string;
  /** 1-based line in the source script, for scenario steps. */
  line?: number;
  /** The events this step added: `events.slice(from, to)`. */
  from: number;
  to: number;
  /** Why the step failed: a rejected command or a failed check. */
  failure?: string;
}

export interface Timeline {
  events: GameEvent[];
  steps: TimelineStep[];
}

/**
 * A timeline for a recorded event log, one step per command. Every event a command produces
 * shares its `at` and `by`, so consecutive events that match on both are grouped.
 */
export function timelineFromEvents(events: GameEvent[]): Timeline {
  const steps: TimelineStep[] = [];
  events.forEach((ev, i) => {
    const prev = events[i - 1];
    const last = steps[steps.length - 1];
    if (last && prev && prev.at === ev.at && JSON.stringify(prev.by) === JSON.stringify(ev.by)) {
      last.to = i + 1;
      return;
    }
    steps.push({
      kind: ev.type === 'GameStarted' ? 'setup' : 'command',
      text: ev.type,
      from: i,
      to: i + 1,
    });
  });
  return { events, steps };
}

/**
 * The full (server) state after each event, built once so a player can jump anywhere.
 * `states[n]` is the state after the first `n` events; `states[0]` is the empty game.
 */
export function timelineStates(timeline: Timeline, gameId = 'replay'): GameState[] {
  const states = [newGame(gameId)];
  for (const ev of timeline.events) states.push(evolve(states[states.length - 1] as GameState, ev));
  return states;
}
