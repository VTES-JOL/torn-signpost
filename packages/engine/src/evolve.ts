import type { GameEvent } from './events.ts';
import {
  type CardId,
  type CardInstance,
  type GameId,
  type GameState,
  type InstanceId,
  type Seat,
  ZONE_NAMES,
  type ZoneId,
} from './model.ts';
import type { SeatId } from './seating.ts';
import { HIDDEN_ZONES, IN_PLAY_ZONES, parseZoneId, zoneId } from './zones.ts';

export const ENGINE_VERSION = '0.1.0';

export function newGame(id: GameId): GameState {
  return {
    id,
    engineVersion: ENGINE_VERSION,
    format: 'standard',
    seq: 0,
    seats: [],
    turnDirection: 'toPrey',
    cards: {},
    zones: {},
    settings: { tournament: false, startingPool: 30 },
    status: 'setup',
  };
}

/**
 * Apply one event. Pure and deterministic: the input is never mutated, and the same function runs
 * on the full server state and on a redacted view (a view must be re-projected afterwards, since
 * an event may move a card the viewer saw into a zone they can't see).
 */
export function evolve(state: GameState, ev: GameEvent): GameState {
  const d = draft(state);
  d.seq = ev.seq;
  switch (ev.type) {
    case 'GameStarted': {
      d.id = ev.gameId;
      d.format = ev.format;
      d.settings = { ...ev.settings };
      d.seats = ev.seats.map(
        (s): Seat => ({
          id: s.id,
          occupant: s.user,
          occupants: [{ user: s.user, from: ev.seq, reason: 'start' }],
          pool: ev.settings.startingPool,
          vp: 0,
          hasEdge: false,
        }),
      );
      d.zones = {};
      for (const s of ev.seats) for (const z of ZONE_NAMES) d.zones[zoneId(s.id, z)] = [];
      d.cards = {};
      for (const c of ev.cards) {
        d.cards[c.id] = withCardId(blankCard(c.id, c.owner, c.zone), c.cardId);
        zoneOf(d, c.zone).push(c.id);
      }
      const first = ev.seats[0];
      if (first) d.turn = { number: 1, seat: first.id, phase: 'unlock' };
      d.status = 'active';
      break;
    }
    case 'CardMoved': {
      const card = cardOf(d, ev.card);
      const fromName = parseZoneId(card.zone).name;
      const { seat: toSeat, name: toName } = parseZoneId(ev.to);
      removeFromZone(d, card.zone, card.id);
      let moved: CardInstance = withCardId(
        { ...card, zone: ev.to, controller: toSeat, faceDown: ev.faceDown },
        ev.cardId,
      );
      delete moved.attachedTo;
      if (HIDDEN_ZONES.has(toName)) {
        moved = withCardId(blankCard(card.id, card.owner, ev.to), moved.cardId);
      }
      if (ev.newId) {
        delete d.cards[card.id];
        moved.id = ev.newId;
        delete moved.judgeRevealed;
      }
      d.cards[moved.id] = moved;
      insert(d, ev.to, moved.id, ev.position);
      // Attached cards travel with their host between in-play zones; otherwise they're detached.
      const carry = IN_PLAY_ZONES.has(fromName) && IN_PLAY_ZONES.has(toName);
      for (const child of Object.values(d.cards)) {
        if (child.attachedTo !== card.id) continue;
        const next: CardInstance = { ...child };
        if (carry) {
          removeFromZone(d, child.zone, child.id);
          next.zone = ev.to;
          next.controller = toSeat;
          next.attachedTo = moved.id;
          zoneOf(d, ev.to).push(child.id);
        } else {
          delete next.attachedTo;
        }
        d.cards[child.id] = next;
      }
      break;
    }
    case 'CardsDrawn': {
      const src = zoneId(ev.seat, ev.from);
      const dest = zoneId(ev.seat, ev.from === 'crypt' ? 'uncontrolled' : 'hand');
      for (const r of ev.cards) {
        const old = cardOf(d, r.id);
        removeFromZone(d, src, r.id);
        delete d.cards[r.id];
        d.cards[r.newId] = withCardId(blankCard(r.newId, old.owner, dest), r.cardId ?? old.cardId);
        zoneOf(d, dest).push(r.newId);
      }
      break;
    }
    case 'ZoneShuffled': {
      const { seat } = parseZoneId(ev.zone);
      const old = zoneOf(d, ev.zone).map((id) => cardOf(d, id));
      for (const c of old) delete d.cards[c.id];
      ev.ids.forEach((id, i) => {
        const prev = ev.from ? old.find((c) => c.id === ev.from?.[i]) : undefined;
        if (!prev) {
          d.cards[id] = blankCard(id, seat, ev.zone);
          return;
        }
        const next: CardInstance = { ...prev, id };
        delete next.judgeRevealed;
        d.cards[id] = next;
      });
      d.zones[ev.zone] = [...ev.ids];
      break;
    }
    case 'CardFlipped': {
      const card = cardOf(d, ev.card);
      const next = withCardId({ ...card, faceDown: ev.faceDown }, ev.cardId);
      if (ev.newId) rekeyInPlace(d, card, { ...next, id: ev.newId });
      else d.cards[card.id] = next;
      break;
    }
    case 'CardLocked':
      patchCard(d, ev.card, { locked: ev.locked });
      break;
    case 'CardContested':
      patchCard(d, ev.card, { contested: ev.contested });
      break;
    case 'CounterAdjusted':
      addCounter(d, ev.card, ev.counter, ev.delta);
      break;
    case 'PoolAdjusted':
      patchSeat(d, ev.seat, (s) => ({ pool: s.pool + ev.delta }));
      break;
    case 'VpAdjusted':
      patchSeat(d, ev.seat, (s) => ({ vp: s.vp + ev.delta }));
      break;
    case 'BloodTransferred':
      for (const [holder, delta] of [
        [ev.from, -ev.amount],
        [ev.to, ev.amount],
      ] as const) {
        if ('pool' in holder) patchSeat(d, holder.pool, (s) => ({ pool: s.pool + delta }));
        else addCounter(d, holder.card, 'blood', delta);
      }
      break;
    case 'CardAttached': {
      const next: CardInstance = { ...cardOf(d, ev.card) };
      if (ev.to) next.attachedTo = ev.to;
      else delete next.attachedTo;
      d.cards[next.id] = next;
      break;
    }
    case 'CardRevealed':
      break;
    case 'JudgeRevealed': {
      const card = cardOf(d, ev.card);
      d.cards[card.id] = withCardId({ ...card, judgeRevealed: true }, ev.cardId);
      break;
    }
    case 'EdgeSet':
      d.seats = d.seats.map((s) => ({ ...s, hasEdge: s.id === ev.seat }));
      break;
    case 'TurnDirectionSet':
      d.turnDirection = ev.direction;
      break;
    case 'PhaseAdvanced':
      d.turn = { ...ev.turn };
      break;
    case 'PlayerReplaced':
      patchSeat(d, ev.seat, (s) => ({
        occupant: ev.user,
        occupants: [
          ...s.occupants.map((o) => (o.to === undefined ? { ...o, to: ev.seq } : o)),
          { user: ev.user, from: ev.seq, reason: 'replaced' },
        ],
      }));
      break;
  }
  return d;
}

/** Shallow copy deep enough that `evolve` never mutates its input. Card objects are replaced, not edited. */
function draft(s: GameState): GameState {
  const zones: Record<ZoneId, InstanceId[]> = {};
  for (const [z, ids] of Object.entries(s.zones)) zones[z as ZoneId] = [...ids];
  const d: GameState = {
    ...s,
    seats: s.seats.map((x) => ({ ...x, occupants: [...x.occupants] })),
    cards: { ...s.cards },
    zones,
    settings: { ...s.settings },
  };
  if (s.turn) d.turn = { ...s.turn };
  return d;
}

/** A card as it sits in a hidden zone: no state carried over from wherever it was before. */
function blankCard(id: InstanceId, owner: SeatId, zone: ZoneId): CardInstance {
  return {
    id,
    owner,
    controller: parseZoneId(zone).seat,
    zone,
    locked: false,
    faceDown: false,
    contested: false,
    counters: {},
  };
}

function withCardId(card: CardInstance, cardId: CardId | undefined): CardInstance {
  if (cardId !== undefined) card.cardId = cardId;
  return card;
}

function cardOf(d: GameState, id: InstanceId): CardInstance {
  const card = d.cards[id];
  if (!card) throw new Error(`Unknown card instance: ${id}`);
  return card;
}

function zoneOf(d: GameState, zone: ZoneId): InstanceId[] {
  d.zones[zone] ??= [];
  return d.zones[zone];
}

function removeFromZone(d: GameState, zone: ZoneId, id: InstanceId) {
  d.zones[zone] = zoneOf(d, zone).filter((x) => x !== id);
}

function insert(d: GameState, zone: ZoneId, id: InstanceId, position: 'top' | 'bottom') {
  if (position === 'top') zoneOf(d, zone).unshift(id);
  else zoneOf(d, zone).push(id);
}

function patchCard(d: GameState, id: InstanceId, patch: Partial<CardInstance>) {
  d.cards[id] = { ...cardOf(d, id), ...patch };
}

function addCounter(
  d: GameState,
  id: InstanceId,
  counter: keyof CardInstance['counters'],
  delta: number,
) {
  const card = cardOf(d, id);
  const counters = { ...card.counters };
  const value = (counters[counter] ?? 0) + delta;
  if (value === 0) delete counters[counter];
  else counters[counter] = value;
  d.cards[id] = { ...card, counters };
}

function patchSeat(d: GameState, id: SeatId, patch: (s: Seat) => Partial<Seat>) {
  d.seats = d.seats.map((s) => (s.id === id ? { ...s, ...patch(s) } : s));
}

/** Replace a card with a re-keyed copy, keeping its zone position and its attachments. */
function rekeyInPlace(d: GameState, old: CardInstance, next: CardInstance) {
  delete d.cards[old.id];
  delete next.judgeRevealed;
  d.cards[next.id] = next;
  d.zones[old.zone] = zoneOf(d, old.zone).map((x) => (x === old.id ? next.id : x));
  for (const c of Object.values(d.cards)) {
    if (c.attachedTo === old.id) d.cards[c.id] = { ...c, attachedTo: next.id };
  }
}
