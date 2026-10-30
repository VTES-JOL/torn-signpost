import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type CardInfo, createCatalog } from './catalog.ts';
import type { Command } from './commands.ts';
import { decide } from './decide.ts';
import type { GameEvent } from './events.ts';
import { evolve, newGame } from './evolve.ts';
import { impulseHolder } from './flow.ts';
import {
  ACTION_KINDS,
  type Actor,
  type CardInstance,
  type GameState,
  PHASES,
  type Viewer,
  ZONE_NAMES,
} from './model.ts';
import { canSee, project, projectEvent } from './projection.ts';
import { seededRng } from './rng.ts';
import { zoneId } from './zones.ts';

/**
 * Hidden-information properties (architecture §4.5, §11). Every physical card has a unique card
 * ID here, so any card ID that shows up in a projection can be traced to exactly one card.
 */
const SEATS = ['A', 'B', 'C', 'D', 'E'];
const CRYPT = 8;
const LIBRARY = 15;
const cardId = (seat: string, kind: string, i: number) => `card-${seat}-${kind}-${i}`;
const catalog = createCatalog(
  SEATS.flatMap((s) => [
    ...Array.from(
      { length: CRYPT },
      (_, i): CardInfo => ({ id: cardId(s, 'c', i), name: `V ${s}${i}`, kind: 'crypt' }),
    ),
    ...Array.from(
      { length: LIBRARY },
      (_, i): CardInfo => ({ id: cardId(s, 'l', i), name: `L ${s}${i}`, kind: 'library' }),
    ),
  ]),
);
const CARD_ID = /card-[A-E]-[cl]-\d+/g;

type Step = [actor: number, kind: number, a: number, b: number, c: number, d: number];

function start(seatCount: number, seed: number): GameState {
  const seats = SEATS.slice(0, seatCount).map((id) => ({
    id,
    user: `u${id}`,
    crypt: Array.from({ length: CRYPT }, (_, i) => cardId(id, 'c', i)),
    library: Array.from({ length: LIBRARY }, (_, i) => cardId(id, 'l', i)),
  }));
  const result = decide(
    newGame('g'),
    { type: 'StartGame', gameId: 'g', format: 'standard', seats },
    {
      actor: { kind: 'system' },
      now: 't',
      rng: seededRng(seed),
      catalog,
    },
  );
  if (!result.ok) throw new Error(result.rejection.message);
  let state = result.events.reduce(evolve, newGame('g'));
  // Warm up as a real opening would, so random commands find cards in hands and in play.
  const rng = seededRng(seed + 2);
  const run = (user: string, cmd: Command) => {
    const r = decide(state, cmd, { actor: { kind: 'player', user }, now: 't', rng, catalog });
    if (r.ok) state = r.events.reduce(evolve, state);
  };
  for (const { id, user } of seats) {
    run(user, { type: 'Draw', seat: id, from: 'crypt', count: 4 });
    run(user, { type: 'Draw', seat: id, count: 7 });
    for (const zone of ['uncontrolled', 'uncontrolled', 'hand'] as const) {
      const card = state.zones[zoneId(id, zone)]?.[0];
      if (card)
        run(user, { type: 'MoveCard', card, to: zoneId(id, 'ready'), faceDown: zone === 'hand' });
    }
  }
  return state;
}

/** The seat a flow command most plausibly comes from: the impulse holder, else the acting seat. */
function flowSeat(state: GameState): string {
  return impulseHolder(state) ?? state.turn?.seat ?? 'A';
}

/** Turn random numbers into a plausible command; many are rejected, which is fine. */
function commandFor(state: GameState, [, kind, a, b, c, d]: Step): Command {
  const fs = flowSeat(state);
  const pick = (zone: 'ready' | 'hand', n: number) => {
    const ids = state.zones[zoneId(fs, zone)] ?? [];
    return ids[n % Math.max(ids.length, 1)] ?? 'none';
  };
  const seats = state.seats.map((s) => s.id);
  const seat = seats[b % seats.length] ?? 'A';
  // Mostly cards outside crypts and libraries, where most commands apply.
  const all = Object.values(state.zones).flat();
  const live = all.filter((id) => !/:(crypt|library)$/.test(state.cards[id]?.zone ?? ''));
  const ids = d % 5 === 0 ? all : live;
  const card = ids[a % Math.max(ids.length, 1)] ?? 'none';
  const other = ids[d % Math.max(ids.length, 1)] ?? 'none';
  const zone = zoneId(seat, ZONE_NAMES[c % ZONE_NAMES.length] ?? 'ready');
  const commands: Command[] = [
    { type: 'Draw', seat, count: 1 + (c % 3) },
    { type: 'Draw', seat, from: 'crypt', count: 1 + (c % 2) },
    { type: 'MoveCard', card, to: zone },
    { type: 'MoveCard', card, to: zoneId(seat, 'ready'), faceDown: c % 2 === 0 },
    { type: 'MoveCard', card, to: zone, position: d % 2 ? 'top' : 'bottom' },
    { type: 'Flip', card },
    { type: 'SetLocked', card, locked: c % 2 === 0 },
    { type: 'AdjustCounter', card, counter: 'blood', delta: (c % 5) - 2 || 1 },
    { type: 'AdjustPool', seat, delta: (c % 5) - 2 || 1 },
    { type: 'TransferBlood', from: { pool: seat }, to: { card }, amount: 1 + (c % 3) },
    { type: 'TransferBlood', from: { card }, to: { pool: seat }, amount: 1 },
    { type: 'Attach', card, to: other },
    { type: 'Attach', card },
    { type: 'Reveal', card },
    { type: 'JudgeReveal', card },
    { type: 'Shuffle', zone },
    { type: 'AdvancePhase' },
    { type: 'AdvancePhase' },
    { type: 'SetEdge', seat },
    { type: 'SetTurnDirection', direction: c % 2 ? 'toPrey' : 'toPredator' },
    { type: 'ReplacePlayer', seat, user: `new${a % 3}` },
  ];
  const flow: Command[] = [
    { type: 'SetAutoPass', phases: PHASES.filter((_, i) => (c >> i) & 1) },
    {
      type: 'DeclareAction',
      minion: pick('ready', a),
      kind: ACTION_KINDS[c % ACTION_KINDS.length] ?? 'bleed',
      ...(d % 3 === 0 ? { target: seat } : {}),
      ...(d % 2 === 0 ? { card: pick('hand', d) } : {}),
    },
    ...Array.from({ length: 6 }, (): Command => ({ type: 'Pass' })),
    { type: 'Block', minion: pick('ready', a) },
    { type: 'WithdrawBlock' },
    { type: 'PlayCard', card: pick('hand', a), ...(c % 2 ? { to: 'ready' as const } : {}) },
    { type: 'PlayCard', card: pick('hand', a), attachTo: other, replace: d % 2 === 0 },
    { type: 'SetLocked', card: pick('ready', a), locked: false },
    { type: 'ResolveAction', outcome: c % 2 ? 'success' : 'failure', amount: d % 4, edge: true },
    { type: 'EndCombat' },
    { type: 'CancelAction' },
  ];
  const pool = [...commands, ...flow];
  return pool[kind % pool.length] as Command;
}

/**
 * A plausible move by whoever the flow waits on, so random games walk through windows, blocks
 * and resolutions instead of mostly being rejected.
 */
function guidedStep(state: GameState, [, kind, a, , c, d]: Step): [Command, Actor] {
  const fs = flowSeat(state);
  const seat = state.seats.find((s) => s.id === fs);
  const actor: Actor = { kind: 'player', user: seat?.occupant ?? '' };
  const ready = state.zones[zoneId(fs, 'ready')] ?? [];
  const hand = state.zones[zoneId(fs, 'hand')] ?? [];
  const minion = ready[a % Math.max(ready.length, 1)] ?? 'none';
  const card = hand[d % Math.max(hand.length, 1)] ?? 'none';
  const n = kind % 10;
  const act = state.action;
  if (state.window) {
    if (act?.blockAttempt?.seat === fs && n === 0) return [{ type: 'WithdrawBlock' }, actor];
    if (state.window.kind === 'blocks' && n < 3) return [{ type: 'Block', minion }, actor];
    if (n < 5) return [{ type: 'PlayCard', card, replace: c % 2 === 0 }, actor];
    if (n === 5) return [{ type: 'SetAutoPass', phases: [...PHASES] }, actor];
    return [{ type: 'Pass' }, actor];
  }
  if (act?.stage === 'combat') return [{ type: 'EndCombat' }, actor];
  if (act?.stage === 'resolution') {
    if (n === 0) return [{ type: 'CancelAction' }, actor];
    const outcome = c % 3 ? 'success' : 'failure';
    return [{ type: 'ResolveAction', outcome, amount: d % 4, edge: c % 2 === 0 }, actor];
  }
  if (n < 2) {
    const phases = PHASES.filter((_, i) => (c >> i) & 1);
    const other = state.seats[c % state.seats.length];
    return [
      { type: 'SetAutoPass', phases },
      { kind: 'player', user: other?.occupant ?? '' },
    ];
  }
  if (state.turn?.phase === 'minion' && n < 8) {
    const target = state.seats[d % state.seats.length]?.id;
    const locked = state.cards[minion]?.locked;
    if (locked) return [{ type: 'SetLocked', card: minion, locked: false }, actor];
    return [
      {
        type: 'DeclareAction',
        minion,
        kind: ACTION_KINDS[c % ACTION_KINDS.length] ?? 'bleed',
        ...(d % 3 === 0 && target ? { target } : {}),
        ...(d % 2 === 0 ? { card } : {}),
      },
      actor,
    ];
  }
  return [{ type: 'AdvancePhase' }, actor];
}

function actorFor(state: GameState, [actor]: Step): Actor {
  if (actor % 8 === 6) return { kind: 'judge', user: 'j' };
  if (actor % 8 === 7) return { kind: 'admin', user: 'adm' };
  const seat = state.seats[actor % state.seats.length];
  return { kind: 'player', user: seat?.occupant ?? '' };
}

function viewers(state: GameState): Viewer[] {
  return [
    ...state.seats.map((s): Viewer => ({ kind: 'player', seat: s.id })),
    { kind: 'judge' },
    { kind: 'spectator' },
  ];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Card IDs are unique per physical card here, so index each state once. */
const byCardId = new WeakMap<GameState, Map<string, CardInstance>>();

/**
 * Whether the physical card with this card ID is visible to the viewer in `state`. The card of an
 * action in progress was revealed when it was declared.
 */
function visibleIn(state: GameState, id: string, viewer: Viewer): boolean {
  if (state.action?.cardId === id) return true;
  let index = byCardId.get(state);
  if (!index) {
    index = new Map(Object.values(state.cards).flatMap((c) => (c.cardId ? [[c.cardId, c]] : [])));
    byCardId.set(state, index);
  }
  const card = index.get(id);
  return card !== undefined && canSee(card, viewer);
}

function totalBlood(state: GameState): number {
  return (
    state.seats.reduce((n, s) => n + s.pool, 0) +
    Object.values(state.cards).reduce((n, c) => n + (c.counters.blood ?? 0), 0)
  );
}

/** Run random games, calling `check` for every applied event. */
function forEveryEvent(check: (before: GameState, ev: GameEvent, after: GameState) => void) {
  fc.assert(
    fc.property(
      fc.integer({ min: 3, max: 5 }),
      fc.integer(),
      fc.array(fc.tuple(fc.nat(), fc.nat(), fc.nat(), fc.nat(), fc.nat(), fc.nat()), {
        minLength: 20,
        maxLength: 80,
      }),
      (seatCount, seed, steps) => {
        let state = deepFreeze(start(seatCount, seed));
        const rng = seededRng(seed + 1);
        for (const step of steps) {
          const [command, actor] =
            step[0] % 5 < 3
              ? guidedStep(state, step)
              : [commandFor(state, step), actorFor(state, step)];
          const result = decide(state, command, {
            actor,
            now: 't',
            rng,
            catalog,
          });
          if (!result.ok) continue;
          for (const ev of result.events) {
            const after = deepFreeze(evolve(state, ev));
            check(state, ev, after);
            state = after;
          }
        }
      },
    ),
    { numRuns: 150 },
  );
}

// Property suites run hundreds of random games; allow for slower CI runners.
describe('hidden information', { timeout: 60_000 }, () => {
  it('a projected state never contains the identity of a card the viewer cannot see', () => {
    forEveryEvent((_, __, after) => {
      for (const v of viewers(after)) {
        for (const id of JSON.stringify(project(after, v)).match(CARD_ID) ?? []) {
          expect(visibleIn(after, id, v), `${id} leaked to ${JSON.stringify(v)}`).toBe(true);
        }
      }
    });
  });

  it('a projected event only names cards the viewer could see before or after it', () => {
    forEveryEvent((before, ev, after) => {
      if (ev.type === 'CardRevealed' || ev.type === 'ActionDeclared') return;
      for (const v of viewers(after)) {
        for (const id of JSON.stringify(projectEvent(before, after, ev, v)).match(CARD_ID) ?? []) {
          const ok = visibleIn(before, id, v) || visibleIn(after, id, v);
          expect(ok, `${ev.type} leaked ${id} to ${JSON.stringify(v)}`).toBe(true);
        }
      }
    });
  });

  it('a shuffle never links new instance IDs to old ones for viewers who cannot see the zone', () => {
    forEveryEvent((before, ev, after) => {
      if (ev.type !== 'ZoneShuffled') return;
      const oldIds = before.zones[ev.zone] ?? [];
      for (const v of viewers(after)) {
        const json = JSON.stringify(projectEvent(before, after, ev, v));
        const sees = oldIds.every((id) => {
          const card = before.cards[id];
          return card !== undefined && canSee(card, v);
        });
        if (!sees) for (const id of oldIds) expect(json).not.toContain(id);
      }
      for (const id of ev.ids) expect(oldIds).not.toContain(id);
    });
  });

  it('random games reach the structured flow', () => {
    const seen = new Set<string>();
    forEveryEvent((_, ev) => {
      seen.add(ev.type === 'Passed' && ev.auto ? 'Passed(auto)' : ev.type);
    });
    for (const type of [
      'WindowOpened',
      'Passed',
      'Passed(auto)',
      'ImpulseReset',
      'ActionDeclared',
      'BlockAttempted',
      'ActionBlocked',
      'ActionResolving',
      'ActionEnded',
      'AutoPassSet',
    ]) {
      expect(seen, type).toContain(type);
    }
  });

  it('clients can follow the game from projected events alone', () => {
    forEveryEvent((before, ev, after) => {
      for (const v of viewers(after)) {
        const followed = project(evolve(project(before, v), projectEvent(before, after, ev, v)), v);
        expect(followed).toEqual(project(after, v));
      }
    });
  });
});

describe('engine invariants', { timeout: 60_000 }, () => {
  it('evolve never mutates its input (states are deep-frozen) and blood is conserved by transfers', () => {
    forEveryEvent((before, ev, after) => {
      if (ev.type === 'BloodTransferred') expect(totalBlood(after)).toBe(totalBlood(before));
      expect(after.seq).toBe(ev.seq);
    });
  });
});
