/**
 * Plays a timeline (a scenario now, a recorded game later) in the browser with no server: the
 * table, toolbar, log and console run against it exactly as they do against a live game.
 *
 * Every state is rebuilt from the timeline's events, then redacted for the chosen viewer with
 * the engine's projection, so a replay shows each seat only what that seat could see.
 * Commands sent from the table are decided locally and branch the timeline at the current step.
 */
import {
  type Actor,
  type CardCatalog,
  decide,
  describeEvent,
  evolve,
  type GameEvent,
  type GameState,
  project,
  projectEvent,
  seededRng,
  type Timeline,
  type TimelineStep,
  timelineStates,
  type Viewer,
} from '@torn-signpost/engine';
import type { PlayerCommand } from '@torn-signpost/protocol';
import { ApiError } from '../api.ts';
import type { GameSnapshot, LogLine, TableClient } from '../game/client.ts';

export interface ReplayStep extends TimelineStep {
  /** Played in the browser on top of the timeline, rather than part of it. */
  live?: boolean;
}

export interface ReplayPosition {
  steps: readonly ReplayStep[];
  /** How many steps have been played: 0 is before the first. */
  cursor: number;
}

export class ReplayClient implements TableClient {
  private events: GameEvent[];
  private steps: ReplayStep[];
  /** `states[n]` is the full state after the first `n` events. */
  private states: GameState[];
  private cursor = 0;
  private viewer: Viewer = { kind: 'spectator' };
  /** Log lines for every event, per viewer; built on demand. */
  private readonly logs = new Map<string, (LogLine | undefined)[]>();
  private readonly listeners = new Set<() => void>();
  private snapshot!: GameSnapshot;
  private position!: ReplayPosition;

  constructor(
    private readonly timeline: Timeline,
    private readonly catalog: CardCatalog,
  ) {
    this.events = [...timeline.events];
    this.steps = [...timeline.steps];
    this.states = timelineStates(timeline);
    this.refresh();
  }

  /** Drops anything played here and goes back to the original timeline, at the same step. */
  reset(): void {
    const cursor = this.steps.findIndex((s) => s.live);
    this.events = [...this.timeline.events];
    this.steps = [...this.timeline.steps];
    this.states = timelineStates(this.timeline);
    this.logs.clear();
    this.cursor = cursor < 0 ? this.cursor : cursor;
    this.refresh();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;
  getPosition = () => this.position;

  /** Show the game as it was after `cursor` steps. */
  goto(cursor: number): void {
    const next = Math.max(0, Math.min(this.steps.length, cursor));
    if (next === this.cursor) return;
    this.cursor = next;
    this.refresh();
  }

  setViewer(viewer: Viewer): void {
    this.viewer = viewer;
    this.refresh();
  }

  /** Decides the command against the current state; on success the replay continues from there. */
  async send(command: PlayerCommand): Promise<void> {
    const state = this.current();
    const actor = this.actor(state);
    const result = decide(state, command, {
      actor,
      now: new Date().toISOString(),
      rng: seededRng(this.eventCount() + 1),
      catalog: this.catalog,
    });
    if (!result.ok) throw new ApiError(409, result.rejection.code, result.rejection.message);
    // Branch: whatever came after this step is replaced by what was just played.
    const from = this.eventCount();
    this.events = [...this.events.slice(0, from), ...result.events];
    this.states = this.states.slice(0, from + 1);
    for (const ev of result.events) {
      this.states.push(evolve(this.states[this.states.length - 1] as GameState, ev));
    }
    const who = this.viewer.kind === 'player' ? `${this.viewer.seat}> ` : 'judge> ';
    this.steps = [
      ...this.steps.slice(0, this.cursor),
      { kind: 'command', text: `${who}${command.type}`, from, to: this.events.length, live: true },
    ];
    this.cursor = this.steps.length;
    this.logs.clear();
    this.refresh();
  }

  async say(): Promise<void> {
    throw new ApiError(409, 'not-available', 'There is no chat in a replay');
  }

  seatName = (seat: string): string =>
    this.current().seats.find((s) => s.id === seat)?.occupant ?? seat;

  private eventCount(): number {
    return this.cursor === 0 ? 0 : (this.steps[this.cursor - 1]?.to ?? 0);
  }

  private current(): GameState {
    return this.states[this.eventCount()] as GameState;
  }

  private actor(state: GameState): Actor {
    const viewer = this.viewer;
    if (viewer.kind === 'judge') return { kind: 'judge', user: 'judge' };
    if (viewer.kind !== 'player') {
      throw new ApiError(409, 'forbidden', 'Watch as a seat or the judge to play on from here');
    }
    const occupant = state.seats.find((s) => s.id === viewer.seat)?.occupant;
    if (!occupant) throw new ApiError(409, 'forbidden', `No seat ${viewer.seat}`);
    return { kind: 'player', user: occupant };
  }

  private logFor(viewer: Viewer): (LogLine | undefined)[] {
    const key = JSON.stringify(viewer);
    let lines = this.logs.get(key);
    if (!lines) {
      lines = this.events.map((ev, i) => {
        const before = this.states[i] as GameState;
        const after = this.states[i + 1] as GameState;
        const seatName = (seat: string) => after.seats.find((s) => s.id === seat)?.occupant ?? seat;
        const text = describeEvent(
          projectEvent(before, after, ev, viewer),
          project(before, viewer),
          {
            catalog: this.catalog,
            seatName,
          },
        );
        return text ? { seq: ev.seq, at: ev.at, text } : undefined;
      });
      this.logs.set(key, lines);
    }
    return lines;
  }

  private refresh() {
    const count = this.eventCount();
    const state = this.current();
    const viewer = this.viewer;
    const seat = viewer.kind === 'player' ? viewer.seat : undefined;
    this.snapshot = {
      status: 'live',
      viewer,
      ...(seat ? { seat } : {}),
      view: project(state, viewer),
      log: this.logFor(viewer)
        .slice(0, count)
        .filter((l): l is LogLine => l !== undefined),
      chat: [],
    };
    this.position = { steps: this.steps, cursor: this.cursor };
    for (const l of this.listeners) l();
  }
}
