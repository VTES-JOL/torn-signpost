/**
 * Structured flow helpers (architecture §4.4, GAME-05/06): who holds the impulse, who passes
 * automatically, and who may block. Shared by `decide`, the toolbar offers and the clients.
 */
import {
  COMBAT_STEPS,
  type GameState,
  type InstanceId,
  type Instant,
  PHASES,
  type Phase,
  type Seat,
  type StopRule,
} from './model.ts';
import { predator, prey, type SeatId, type SeatRef } from './seating.ts';

export function seatRefs(state: GameState): SeatRef[] {
  return state.seats.map((s) => ({ id: s.id, ousted: !!(s.ousted || s.withdrawn) }));
}

/**
 * How the game is being played (TEMPO-06): `live` while every Methuselah still in the game has it
 * open, `async` otherwise. Spectators and judges don't count.
 */
export type Tempo = 'live' | 'async';

export function tempo(state: GameState): Tempo {
  const live = state.seats.filter((s) => !s.ousted && !s.withdrawn);
  return live.length > 0 && live.every((s) => s.present) ? 'live' : 'async';
}

/**
 * What a seat is being waited on for (UX-09):
 * - `phase`: the acting Methuselah, to act or end the phase;
 * - `impulse`: the impulse holder in a window, to play a card or pass;
 * - `block`: an eligible blocker holding the impulse in a block window, to block or not;
 * - `resolve`: the acting Methuselah, to resolve an unblocked action (holding the impulse in its
 *   would-be-successful window, or after it);
 * - `combat`: in a combat step, the combatant holding the impulse; in a combat from before
 *   combat steps (M6.4), the two Methuselahs in it, to end it;
 * - `vote`: the seat holding the impulse in a referendum's polling step, to cast votes or pass.
 */
export type WaitKind = 'phase' | 'impulse' | 'block' | 'resolve' | 'combat' | 'vote' | 'diablerie';

export interface Wait {
  seat: SeatId;
  kind: WaitKind;
  /** When the current wait began: the event that started it. */
  since: { seq: number; at?: Instant };
}

/**
 * Who the game is waiting on, derived from the flow state (docs/m5b-plan.md, decision 1). Never
 * empty while the game is active, and never names a seat that is out of the game. Prompts,
 * deadlines and notifications all read this one function.
 */
export function waitingOn(state: GameState): Wait[] {
  const since = state.waiting
    ? { seq: state.waiting.seq, at: state.waiting.at }
    : { seq: state.seq };
  return currentWaits(state).map((w) => ({ ...w, since }));
}

/** Whether the game is waiting on `seat`. */
export function isWaitingOn(state: GameState, seat: SeatId | undefined): boolean {
  return seat !== undefined && currentWaits(state).some((w) => w.seat === seat);
}

/**
 * Identifies the current wait, so `evolve` can tell when a new one begins: a different seat or
 * kind, or the same seat in a new phase or turn. Playing cards within a wait doesn't restart it.
 */
export function waitKey(state: GameState): string {
  const waits = currentWaits(state);
  if (!waits.length) return '';
  const t = state.turn;
  // Each combat step is a decision of its own.
  const c = state.action?.combat;
  const step = c && state.window?.kind === 'combat' ? [`${c.round}.${c.step}`] : [];
  return [
    t ? `${t.number}.${t.phase}` : '',
    ...step,
    ...waits.map((w) => `${w.kind}:${w.seat}`),
  ].join(' ');
}

function currentWaits(state: GameState): Omit<Wait, 'since'>[] {
  const t = state.turn;
  if (state.status !== 'active' || !t) return [];
  const live = (s: SeatId | undefined): s is SeatId =>
    s !== undefined && state.seats.some((x) => x.id === s && !x.ousted && !x.withdrawn);
  const a = state.action;
  if (state.window) {
    const holder = impulseHolder(state);
    if (!live(holder)) return [];
    if (state.window.kind === 'combat') {
      // A Methuselah outside the combat may play what reaches it (zero-vtes rules-qa 98.2).
      return [{ seat: holder, kind: combatantOf(state, holder) ? 'combat' : 'impulse' }];
    }
    if (state.window.kind === 'polling') return [{ seat: holder, kind: 'vote' }];
    // Not blocked: the acting Methuselah resolves it, or plays first (zero-vtes digest §10.1).
    if (state.window.kind === 'would-succeed' && holder === a?.seat) {
      return [{ seat: holder, kind: 'resolve' }];
    }
    const blocking =
      state.window.kind === 'blocks' &&
      a !== undefined &&
      !a.blockAttempt &&
      a.eligible.includes(holder) &&
      !a.declined.includes(holder);
    return [{ seat: holder, kind: blocking ? 'block' : 'impulse' }];
  }
  if (a?.stage === 'resolution') return live(a.seat) ? [{ seat: a.seat, kind: 'resolve' }] : [];
  if (a?.stage === 'diablerie') {
    // A blocked leave-torpor action: the blocking vampire's Methuselah decides.
    const by = a.blocker === undefined ? undefined : state.cards[a.blocker]?.controller;
    return live(by) ? [{ seat: by, kind: 'diablerie' }] : [];
  }
  if (a?.stage === 'combat') {
    const blocker = a.blocker === undefined ? undefined : state.cards[a.blocker]?.controller;
    return [a.seat, blocker]
      .filter((s, i, all): s is SeatId => live(s) && all.indexOf(s) === i)
      .map((seat) => ({ seat, kind: 'combat' as const }));
  }
  return live(t.seat) ? [{ seat: t.seat, kind: 'phase' }] : [];
}

/** The seat holding the impulse in the open window, if any. */
export function impulseHolder(state: GameState): SeatId | undefined {
  const w = state.window;
  return w ? w.order[w.cursor] : undefined;
}

/** The phases a seat passes automatically at phase end; every phase unless they changed it. */
export function autoPassPhases(seat: Seat): readonly Phase[] {
  return seat.autoPass ?? PHASES;
}

/** A seat's standing stops; none unless they set some. */
export function stopRules(seat: Seat): readonly StopRule[] {
  return seat.stops ?? [];
}

/**
 * Whether a stop rule fires in the open window. The single matching point for stop triggers:
 * player-defined triggers (cards played, action kinds…) are added here as new `StopRule` variants.
 */
export function stopApplies(state: GameState, seat: SeatId, rule: StopRule): boolean {
  const w = state.window;
  if (!w) return false;
  switch (rule.on) {
    case 'block-window': {
      const a = state.action;
      if (w.kind !== 'blocks' || !a || a.seat === seat) return false;
      if (rule.actors === 'anyone') return true;
      const refs = seatRefs(state);
      return prey(refs, seat) === a.seat || predator(refs, seat) === a.seat;
    }
  }
}

/** Whether the seat asked to hold the open window. */
export function isHolding(state: GameState, seat: SeatId): boolean {
  return !!state.window?.holds?.includes(seat);
}

/**
 * Whether `seat` passes the open window automatically: never the acting Methuselah, never a
 * seat that can still block, holds the window or has a stop that fires; otherwise per its
 * auto-pass setting for the window's phase.
 */
export function passesAutomatically(state: GameState, seat: SeatId): boolean {
  const w = state.window;
  if (!w) return false;
  // Combat steps: only a standing pass (C6), and never past a strike still to announce.
  if (w.kind === 'combat' && combatantOf(state, seat) !== undefined) {
    const c = state.action?.combat;
    if (!c) return false;
    if (c.step === 'strikes') {
      // In an additional exchange, a combatant without an additional strike sits it out.
      const m = combatantOf(state, seat);
      return !!c.exchange && m !== undefined && !c.exchange.includes(m);
    }
    const until = c.passUntil?.[seat];
    if (!until) return false;
    return until === 'end' || COMBAT_STEPS.indexOf(c.step) < COMBAT_STEPS.indexOf(until);
  }
  // Polling: everyone passes by hand, unless they abstain from the rest of it (M6.5, R4).
  if (w.kind === 'polling') return !!state.action?.referendum?.abstaining?.includes(seat);
  // Outside a combat, the Methuselahs pass its steps as they would any window (rules-qa 98.1).
  if (w.order[0] === seat) return false;
  const a = state.action;
  if (w.kind === 'blocks' && a) {
    if (a.seat === seat) return false;
    if (a.blockAttempt?.seat === seat) return false;
    if (a.eligible.includes(seat) && !a.declined.includes(seat)) return false;
  }
  if (isHolding(state, seat)) return false;
  const s = state.seats.find((x) => x.id === seat);
  if (!s) return false;
  if (stopRules(s).some((r) => stopApplies(state, seat, r))) return false;
  return autoPassPhases(s).includes(w.phase);
}

/** Seats that may block an action: the target, or prey and predator for undirected actions. */
export function eligibleBlockers(
  state: GameState,
  acting: SeatId,
  target: SeatId | undefined,
): SeatId[] {
  if (target !== undefined) return [target];
  const refs = seatRefs(state);
  const out: SeatId[] = [];
  for (const s of [prey(refs, acting), predator(refs, acting)]) {
    if (s !== undefined && s !== acting && !out.includes(s)) out.push(s);
  }
  return out;
}

/** The Methuselahs of the two combatants: the acting minion's first (M6.4). */
export function combatSeats(state: GameState): SeatId[] {
  const c = state.action?.combat;
  if (!c) return [];
  const seats = [c.acting, c.opposing]
    .map((id) => state.cards[id]?.controller)
    .filter((s): s is SeatId => s !== undefined);
  return seats.filter((s, i) => seats.indexOf(s) === i);
}

/** The combatant `seat` controls, if any. */
export function combatantOf(state: GameState, seat: SeatId): InstanceId | undefined {
  const c = state.action?.combat;
  if (!c) return undefined;
  return [c.acting, c.opposing].find((id) => state.cards[id]?.controller === seat);
}
