/**
 * Per-viewer projection (architecture §4.5, GAME-15/16). Hidden cards are sent without `cardId`;
 * because cards are re-keyed whenever they enter a hidden zone, turn face down or are shuffled,
 * instance IDs can't be used to follow a card through hidden zones.
 */
import type { GameEvent, Rekey } from './events.ts';
import type { CardInstance, GameState, InstanceId, UserId, Viewer } from './model.ts';
import { HIDDEN_ZONES, parseZoneId, zoneCards } from './zones.ts';

/**
 * - Public zones: everyone sees face-up cards; face-down cards only their owner.
 * - Hand and uncontrolled region: only the seat whose zone it is.
 * - Crypt and library: nobody (not even the owner).
 * - Judges additionally see cards revealed to them with `JudgeReveal`; the server sees everything.
 */
export function canSee(card: CardInstance, viewer: Viewer): boolean {
  if (viewer.kind === 'server') return true;
  if (viewer.kind === 'judge' && card.judgeRevealed) return true;
  const { seat, name } = parseZoneId(card.zone);
  if (!HIDDEN_ZONES.has(name)) {
    return !card.faceDown || (viewer.kind === 'player' && viewer.seat === card.owner);
  }
  if (name === 'hand' || name === 'uncontrolled') {
    return viewer.kind === 'player' && viewer.seat === seat;
  }
  return false;
}

/** The viewer for a user: their seat while they occupy one, otherwise judge or spectator. */
export function viewerFor(state: GameState, user: UserId, opts: { judge?: boolean } = {}): Viewer {
  const seat = state.seats.find((s) => s.occupant === user);
  if (seat) return { kind: 'player', seat: seat.id };
  return opts.judge ? { kind: 'judge' } : { kind: 'spectator' };
}

export function project(state: GameState, viewer: Viewer): GameState {
  if (viewer.kind === 'server') return state;
  const cards: Record<InstanceId, CardInstance> = {};
  for (const [id, card] of Object.entries(state.cards)) {
    cards[id] = card.cardId === undefined || canSee(card, viewer) ? card : omitCardId(card);
  }
  // Auto-pass settings are private to their seat.
  const own = viewer.kind === 'player' ? viewer.seat : undefined;
  const seats = state.seats.some((s) => s.autoPass && s.id !== own)
    ? state.seats.map((s) => {
        if (!s.autoPass || s.id === own) return s;
        const { autoPass: _, ...rest } = s;
        return rest;
      })
    : state.seats;
  return { ...state, cards, seats };
}

/**
 * Redact one event for a viewer, given the full states before and after it. A card's identity is
 * included only if the viewer could see the card before or after the event (or the event is a
 * public reveal); a shuffle's old→new ID mapping only if the viewer can see the zone.
 */
export function projectEvent(
  before: GameState,
  after: GameState,
  ev: GameEvent,
  viewer: Viewer,
): GameEvent {
  if (viewer.kind === 'server') return ev;
  const seen = (beforeId: InstanceId, afterId: InstanceId) => {
    const b = before.cards[beforeId];
    const a = after.cards[afterId];
    return (b !== undefined && canSee(b, viewer)) || (a !== undefined && canSee(a, viewer));
  };
  switch (ev.type) {
    case 'GameStarted':
      return {
        ...ev,
        cards: ev.cards.map((c) => {
          const card = after.cards[c.id];
          return card && canSee(card, viewer) ? c : omitCardId(c);
        }),
      };
    case 'CardMoved':
    case 'CardFlipped':
    case 'JudgeRevealed':
      return seen(ev.card, ('newId' in ev && ev.newId) || ev.card) ? ev : omitCardId(ev);
    case 'CardsDrawn':
      return {
        ...ev,
        cards: ev.cards.map((r): Rekey => (seen(r.id, r.newId) ? r : omitCardId(r))),
      };
    case 'ZoneShuffled': {
      const visible = zoneCards(after, ev.zone).every((id) => {
        const card = after.cards[id];
        return card !== undefined && canSee(card, viewer);
      });
      if (visible) return ev;
      const { from: _, ...rest } = ev;
      return rest;
    }
    case 'AutoPassSet': {
      if (viewer.kind === 'player' && viewer.seat === ev.seat) return ev;
      const { phases: _, ...rest } = ev;
      return rest;
    }
    default:
      return ev;
  }
}

function omitCardId<T extends { cardId?: unknown }>(value: T): T {
  const { cardId: _, ...rest } = value;
  return rest as T;
}
