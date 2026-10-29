/**
 * Seat-relative helpers (architecture §4.1.1).
 *
 * `seats` is the physical seating in clockwise order and never changes during a game. Prey sits
 * to the left (next seat clockwise), predator to the right (previous seat). Predator/prey are
 * derived from the non-ousted seats, so they update automatically as Methuselahs are ousted.
 * Turn direction only decides who takes the next turn; it never affects predator/prey or
 * impulse order.
 */

export type SeatId = string;

export interface SeatRef {
  readonly id: SeatId;
  readonly ousted?: boolean;
}

export type TurnDirection = 'toPrey' | 'toPredator';

/** Effect direction for building an impulse window order. */
export type WindowFocus = { readonly directedAt: SeatId } | 'undirected';

function indexOf(seats: readonly SeatRef[], seat: SeatId): number {
  const i = seats.findIndex((s) => s.id === seat);
  if (i < 0) throw new Error(`Unknown seat: ${seat}`);
  return i;
}

/** Walk from `seat` one position at a time (+1 clockwise, -1 anticlockwise) to the next live seat. */
function walk(seats: readonly SeatRef[], seat: SeatId, step: 1 | -1): SeatId | undefined {
  const start = indexOf(seats, seat);
  for (let n = 1; n < seats.length; n++) {
    const candidate = seats[(start + step * n + seats.length * n) % seats.length];
    if (candidate && !candidate.ousted) return candidate.id;
  }
  return undefined;
}

export function liveSeats(seats: readonly SeatRef[]): SeatId[] {
  return seats.filter((s) => !s.ousted).map((s) => s.id);
}

/** The next non-ousted seat clockwise (to the left). Undefined if no other seat is live. */
export function prey(seats: readonly SeatRef[], seat: SeatId): SeatId | undefined {
  return walk(seats, seat, 1);
}

/** The next non-ousted seat anticlockwise (to the right). Undefined if no other seat is live. */
export function predator(seats: readonly SeatRef[], seat: SeatId): SeatId | undefined {
  return walk(seats, seat, -1);
}

/**
 * The seat that takes the next turn after `current`. Works from the seat's physical position even
 * when `current` was ousted during its own turn (GAME-21).
 */
export function nextTurnSeat(
  seats: readonly SeatRef[],
  current: SeatId,
  direction: TurnDirection,
): SeatId | undefined {
  return walk(seats, current, direction === 'toPrey' ? 1 : -1);
}

/**
 * Impulse order for an ordered or polling window (architecture §4.4, after zero-vtes): the acting
 * Methuselah first; then the target of a directed effect, or prey then predator for an undirected
 * one; then the remaining live seats clockwise from the acting seat. Always physical seating.
 */
export function windowOrder(
  seats: readonly SeatRef[],
  acting: SeatId,
  focus: WindowFocus,
): SeatId[] {
  const order: SeatId[] = [acting];
  const add = (s: SeatId | undefined) => {
    if (s !== undefined && !order.includes(s) && !seats[indexOf(seats, s)]?.ousted) order.push(s);
  };
  if (focus === 'undirected') {
    add(prey(seats, acting));
    add(predator(seats, acting));
  } else {
    add(focus.directedAt);
  }
  const start = indexOf(seats, acting);
  for (let n = 1; n < seats.length; n++) add(seats[(start + n) % seats.length]?.id);
  return order;
}
