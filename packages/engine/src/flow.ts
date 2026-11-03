/**
 * Structured flow helpers (architecture §4.4, GAME-05/06): who holds the impulse, who passes
 * automatically, and who may block. Shared by `decide`, the toolbar offers and the clients.
 */
import { type GameState, PHASES, type Phase, type Seat, type StopRule } from './model.ts';
import { predator, prey, type SeatId, type SeatRef } from './seating.ts';

export function seatRefs(state: GameState): SeatRef[] {
  return state.seats.map((s) => ({ id: s.id, ousted: !!(s.ousted || s.withdrawn) }));
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
  if (!w || w.order[0] === seat) return false;
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
