import { clockRunning, ms } from './clock.ts';
import type { GameEvent } from './events.ts';
import { waitKey } from './flow.ts';
import {
  type ActionState,
  type CardId,
  type CardInstance,
  type GameId,
  type GameState,
  type ImpulseWindow,
  type InstanceId,
  type Override,
  type Seat,
  ZONE_NAMES,
  type ZoneId,
} from './model.ts';
import type { SeatId } from './seating.ts';
import { HIDDEN_ZONES, IN_PLAY_ZONES, parseZoneId, zoneId } from './zones.ts';

export const ENGINE_VERSION = '0.2.0';

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
  // The table clock counts the time since the last event if it was running then.
  if (d.clock?.runningSince !== undefined) {
    const gap = ms(ev.at) - ms(d.clock.runningSince);
    d.clock = { ...d.clock, elapsedMs: d.clock.elapsedMs + (gap > 0 ? gap : 0) };
  }
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
          awaySince: ev.at,
        }),
      );
      d.clock = { elapsedMs: 0 };
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
        { ...card, zone: ev.to, controller: ev.controller ?? toSeat, faceDown: ev.faceDown },
        ev.cardId,
      );
      delete moved.attachedTo;
      // A burned or removed card loses its counters, and is no longer locked or contested.
      if (toName === 'ashHeap' || toName === 'removed') {
        moved = { ...moved, counters: {}, locked: false, contested: false };
      }
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
          // Minion cards follow their host's controller; a master card stays with its player.
          if (child.controller === card.controller) next.controller = moved.controller;
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
    case 'AutoPassSet': {
      const phases = ev.phases;
      if (phases) patchSeat(d, ev.seat, () => ({ autoPass: [...phases] }));
      break;
    }
    case 'StopsSet': {
      const stops = ev.stops;
      if (stops) patchSeat(d, ev.seat, () => ({ stops: stops.map((r) => ({ ...r })) }));
      break;
    }
    case 'Held': {
      const w = windowOf(d);
      const n = w.order.length;
      const back = (w.cursor - w.order.indexOf(ev.seat) + n) % n;
      // A pass already in the run is voided: the run restarts just after the holding seat.
      const passes = back >= 1 && back <= w.passes ? back - 1 : w.passes;
      d.window = { ...w, passes, holds: [...(w.holds ?? []), ev.seat] };
      break;
    }
    case 'WindowOpened':
      d.window = { ...ev.window, order: [...ev.window.order] };
      break;
    case 'Passed': {
      const w = windowOf(d);
      d.window = { ...w, cursor: (w.cursor + 1) % w.order.length, passes: w.passes + 1 };
      if (!ev.auto && w.holds?.includes(ev.seat)) {
        const holds = w.holds.filter((s) => s !== ev.seat);
        if (holds.length) d.window.holds = holds;
        else delete d.window.holds;
      }
      const a = d.action;
      if (
        w.kind === 'blocks' &&
        a &&
        !a.blockAttempt &&
        a.eligible.includes(ev.seat) &&
        !a.declined.includes(ev.seat)
      ) {
        d.action = { ...a, declined: [...a.declined, ev.seat] };
      }
      break;
    }
    case 'ImpulseReset':
      d.window = { ...windowOf(d), cursor: 0, passes: 0 };
      break;
    case 'WindowClosed':
      delete d.window;
      break;
    case 'ActionDeclared':
      d.action = withOverride(
        { ...ev.action, eligible: [...ev.action.eligible], declined: [] },
        ev.action.override,
      );
      break;
    case 'BlockAttempted':
      d.action = {
        ...actionOf(d),
        blockAttempt: withOverride<NonNullable<ActionState['blockAttempt']>>(
          { seat: ev.seat, minion: ev.minion },
          ev.override,
        ),
      };
      d.window = { ...windowOf(d), cursor: 0, passes: 0 };
      break;
    case 'BlockWithdrawn': {
      const { blockAttempt: _, ...a } = actionOf(d);
      d.action = { ...a, declined: [...a.declined, ev.seat] };
      break;
    }
    case 'ActionBlocked': {
      const { blockAttempt: _, ...a } = actionOf(d);
      d.action = { ...a, stage: 'combat', blocker: ev.blocker };
      break;
    }
    case 'ActionResolving':
      d.action = { ...actionOf(d), stage: 'resolution' };
      break;
    case 'ActionEnded':
      delete d.action;
      delete d.window;
      break;
    case 'Ousted': {
      const by = ev.predator?.seat;
      patchSeat(d, ev.seat, () => ({
        ousted: by === undefined ? { atSeq: ev.seq } : { atSeq: ev.seq, by },
        pool: 0,
        // An ousted Methuselah's Edge is burned.
        hasEdge: false,
        ...(ev.disqualified ? { disqualified: true as const } : {}),
      }));
      const reward = ev.predator;
      if (reward) {
        patchSeat(d, reward.seat, (s) => ({ vp: s.vp + reward.vp, pool: s.pool + reward.pool }));
      }
      // Out of the open window, keeping the impulse and the passes so far.
      const w = d.window;
      const i = w ? w.order.indexOf(ev.seat) : -1;
      if (w && i >= 0) {
        const n = w.order.length;
        const back = (w.cursor - i + n) % n;
        const passed = back >= 1 && back <= w.passes;
        const order = w.order.filter((x) => x !== ev.seat);
        let cursor = i < w.cursor ? w.cursor - 1 : w.cursor;
        if (cursor >= order.length) cursor = 0;
        const holds = w.holds?.filter((x) => x !== ev.seat);
        d.window = {
          ...w,
          order,
          cursor,
          passes: passed ? w.passes - 1 : w.passes,
          ...(holds ? { holds } : {}),
        };
      }
      if (d.action) {
        d.action = {
          ...d.action,
          eligible: d.action.eligible.filter((x) => x !== ev.seat),
          declined: d.action.declined.filter((x) => x !== ev.seat),
        };
      }
      break;
    }
    case 'PlayerPresent': {
      d.seats = d.seats.map((s) => {
        if (s.id !== ev.seat) return s;
        const { awaySince: _, ...rest } = s;
        return { ...rest, present: true };
      });
      // Back at the table: a later absence starts a fresh deadline.
      const w = d.waiting;
      if (w) {
        d.waiting = {
          ...w,
          reminded: (w.reminded ?? []).filter((x) => x !== ev.seat),
          expired: (w.expired ?? []).filter((x) => x !== ev.seat),
        };
      }
      break;
    }
    case 'PlayerAbsent':
      d.seats = d.seats.map((s) =>
        s.id === ev.seat ? { ...withoutPresence(s), awaySince: ev.at } : s,
      );
      break;
    case 'Paused':
      d.pause =
        ev.seat === undefined
          ? { since: ev.at, until: ev.until }
          : { seat: ev.seat, since: ev.at, until: ev.until };
      break;
    case 'Resumed': {
      // A player's pause counts against their allowance for as long as it actually lasted.
      const p = d.pause;
      if (p?.seat !== undefined) {
        const used = Math.max(0, Math.min(ms(ev.at), ms(p.until)) - ms(p.since));
        if (!Number.isNaN(used)) {
          patchSeat(d, p.seat, (s) => ({ pausedMs: (s.pausedMs ?? 0) + used }));
        }
      }
      delete d.pause;
      break;
    }
    case 'DeadlineReminded':
    case 'DeadlineExpired': {
      const w = d.waiting;
      if (!w) break;
      const field = ev.type === 'DeadlineReminded' ? 'reminded' : 'expired';
      d.waiting = { ...w, [field]: [...(w[field] ?? []), ev.seat] };
      break;
    }
    case 'GameEnded':
      for (const a of ev.awards) patchSeat(d, a.seat, (s) => ({ vp: s.vp + a.vp }));
      d.status = 'finished';
      d.result = {
        reason: ev.reason,
        at: ev.at,
        ...(ev.winner !== undefined ? { winner: ev.winner } : {}),
        ...(ev.gameWin !== undefined ? { gameWin: ev.gameWin } : {}),
      };
      delete d.window;
      delete d.action;
      delete d.pause;
      delete d.endProposal;
      delete d.judgeCalls;
      delete d.waiting;
      break;
    case 'EndProposed':
      d.endProposal = { by: ev.seat, agreed: [ev.seat] };
      break;
    case 'EndAgreed':
      if (d.endProposal)
        d.endProposal = { ...d.endProposal, agreed: [...d.endProposal.agreed, ev.seat] };
      break;
    case 'EndDeclined':
      delete d.endProposal;
      break;
    case 'TimeLimitReached':
      if (d.clock) {
        d.clock = { ...d.clock, limitReachedAt: ev.at, endsWith: d.action ? 'action' : 'phase' };
      }
      break;
    case 'TimeExtended': {
      // Time added after the limit was reached reopens it.
      const { limitReachedAt: _, endsWith: __, ...c } = d.clock ?? { elapsedMs: 0 };
      d.clock = { ...c, extendedMs: (c.extendedMs ?? 0) + ev.ms };
      break;
    }
    case 'DeadlineExtended': {
      const w = d.waiting;
      if (!w) break;
      d.waiting = {
        ...w,
        expired: (w.expired ?? []).filter((x) => x !== ev.seat),
        extendedMs: { ...w.extendedMs, [ev.seat]: (w.extendedMs?.[ev.seat] ?? 0) + ev.ms },
      };
      break;
    }
    case 'JudgeCalled':
      d.judgeCalls = [...(d.judgeCalls ?? []), { ...ev.call, id: `c${ev.seq}`, openedAt: ev.at }];
      break;
    case 'JudgeCallClaimed':
      d.judgeCalls = (d.judgeCalls ?? []).map((c) =>
        c.id === ev.id ? { ...c, claimedBy: ev.judge } : c,
      );
      break;
    case 'JudgeCallResolved': {
      const calls = (d.judgeCalls ?? []).filter((c) => c.id !== ev.id);
      if (calls.length) d.judgeCalls = calls;
      else delete d.judgeCalls;
      break;
    }
    case 'PlayerReplaced':
      // The new player is away until the server sees them.
      d.seats = d.seats.map((s) =>
        s.id === ev.seat ? { ...withoutPresence(s), awaySince: ev.at } : s,
      );
      patchSeat(d, ev.seat, (s) => ({
        occupant: ev.user,
        occupants: [
          ...s.occupants.map((o) => (o.to === undefined ? { ...o, to: ev.seq } : o)),
          { user: ev.user, from: ev.seq, reason: 'replaced' },
        ],
      }));
      break;
  }
  // Note when a new wait begins (UX-09); deadlines and prompts count from here.
  const key = waitKey(d);
  if (!key) delete d.waiting;
  else if (d.waiting?.key !== key) d.waiting = { key, seq: ev.seq, at: ev.at };
  // From here the clock runs, or waits, until the next event.
  if (d.clock || d.status === 'active') {
    const { runningSince: _, ...c } = d.clock ?? { elapsedMs: 0 };
    d.clock = clockRunning(d) ? { ...c, runningSince: ev.at } : c;
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

function windowOf(d: GameState): ImpulseWindow {
  if (!d.window) throw new Error('No impulse window open');
  return d.window;
}

function actionOf(d: GameState): ActionState {
  if (!d.action) throw new Error('No action in progress');
  return d.action;
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

function withoutPresence({ present: _, ...s }: Seat): Seat {
  return s;
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

function withOverride<T extends { override?: Override }>(
  value: T,
  override: Override | undefined,
): T {
  if (!override) return value;
  return { ...value, override: { ...override } };
}
