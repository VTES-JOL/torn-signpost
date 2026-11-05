import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type CardInfo, createCatalog } from './catalog.ts';
import {
  clockElapsed,
  clockRunning,
  deadlines,
  HOUR_MS,
  instantFromMs,
  MAX_PAUSE_TOTAL_MINUTES,
  MINUTE_MS,
  ms,
  timers,
} from './clock.ts';
import type { Command } from './commands.ts';
import { decide } from './decide.ts';
import type { GameEvent } from './events.ts';
import { evolve, newGame } from './evolve.ts';
import { impulseHolder, waitingOn, waitKey } from './flow.ts';
import {
  ACTION_KINDS,
  type Actor,
  type CardInstance,
  type GameSettings,
  type GameState,
  PHASES,
  PLAYER_CALL_REASONS,
  type Ruling,
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

type Step = [actor: number, kind: number, a: number, b: number, c: number, d: number, dt: number];

/** Random games run on a real clock, so timers, pauses and deadlines fall due. */
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

/** Tournament (2 h timer), casual with a short timer, or casual without one; short deadlines. */
function settingsFor(seed: number): Partial<GameSettings> {
  const deadlineMs = HOUR_MS;
  switch (Math.abs(seed) % 3) {
    case 0:
      return { tournament: true, deadlineMs };
    case 1:
      return { timeLimitMs: 20 * MINUTE_MS, deadlineMs };
    default:
      return { deadlineMs };
  }
}

/** Mostly seconds between commands, sometimes minutes, now and then hours (async play). */
function advance([, , , , , , dt]: Step): number {
  const n = dt % 20;
  if (n < 14) return (dt % 40) * 1000;
  if (n < 19) return (dt % 12) * MINUTE_MS;
  return (1 + (dt % 4)) * 15 * MINUTE_MS;
}

function start(seatCount: number, seed: number): GameState {
  const seats = SEATS.slice(0, seatCount).map((id) => ({
    id,
    user: `u${id}`,
    crypt: Array.from({ length: CRYPT }, (_, i) => cardId(id, 'c', i)),
    library: Array.from({ length: LIBRARY }, (_, i) => cardId(id, 'l', i)),
  }));
  const result = decide(
    newGame('g'),
    { type: 'StartGame', gameId: 'g', format: 'standard', seats, settings: settingsFor(seed) },
    {
      actor: { kind: 'system' },
      now: instantFromMs(T0),
      rng: seededRng(seed),
      catalog,
    },
  );
  if (!result.ok) throw new Error(result.rejection.message);
  let state = result.events.reduce(evolve, newGame('g'));
  // Warm up as a real opening would, so random commands find cards in hands and in play.
  const rng = seededRng(seed + 2);
  const run = (user: string, cmd: Command, actor: Actor = { kind: 'player', user }) => {
    const r = decide(state, cmd, { actor, now: instantFromMs(T0), rng, catalog });
    if (r.ok) state = r.events.reduce(evolve, state);
  };
  for (const { id, user } of seats) {
    // Most players start at the table; the last one is away, so deadlines come into play.
    if (id !== seats.at(-1)?.id || seed % 2) {
      run(user, { type: 'SetPresence', seat: id, present: true }, { kind: 'system' });
    }
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
      type: 'SetStops',
      stops: c % 3 ? [{ on: 'block-window', actors: c % 2 ? 'anyone' : 'neighbours' }] : [],
    },
    { type: 'Hold' },
    {
      type: 'DeclareAction',
      minion: pick('ready', a),
      kind: ACTION_KINDS[c % ACTION_KINDS.length] ?? 'bleed',
      ...(d % 3 === 0 ? { target: seat } : {}),
      ...(d % 2 === 0 ? { card: pick('hand', d) } : {}),
    },
    ...Array.from({ length: 6 }, (): Command => ({ type: 'Pass' })),
    { type: 'Block', minion: pick('ready', a) },
    { type: 'Block', minion: pick('ready', a), override: { source: pick('hand', d) } },
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
    if (state.window.kind === 'blocks' && n < 3) {
      // Sometimes claim a card effect, played from the hand or not.
      const override = c % 3 === 0 ? { override: d % 2 ? { source: card } : {} } : {};
      return [{ type: 'Block', minion, ...override }, actor];
    }
    if (n < 5) return [{ type: 'PlayCard', card, replace: c % 2 === 0 }, actor];
    if (n === 5) return [{ type: 'SetAutoPass', phases: [...PHASES] }, actor];
    if (n === 6) {
      // Someone else asks the window to wait.
      const other = state.seats[c % state.seats.length];
      return [{ type: 'Hold' }, { kind: 'player', user: other?.occupant ?? '' }];
    }
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
    const by: Actor = { kind: 'player', user: other?.occupant ?? '' };
    if (d % 3 === 0) {
      const actors = d % 2 ? 'anyone' : 'neighbours';
      return [{ type: 'SetStops', stops: [{ on: 'block-window', actors }] }, by];
    }
    return [{ type: 'SetAutoPass', phases }, by];
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
        ...(c % 4 === 0 ? { override: a % 2 ? { source: minion } : {} } : {}),
      },
      actor,
    ];
  }
  return [{ type: 'AdvancePhase' }, actor];
}

/**
 * Presence, pauses and judge calls (TEMPO-03/04/05, GAME-18): players come and go, pause and call
 * judges; judges claim and rule, sometimes wrongly (rejected).
 */
function tableStep(state: GameState, [, kind, a, b, c, d]: Step): [Command, Actor] {
  const seat = state.seats[b % state.seats.length];
  const player: Actor = { kind: 'player', user: seat?.occupant ?? '' };
  const calls = state.judgeCalls ?? [];
  const call = calls[a % Math.max(calls.length, 1)];
  // Usually the judge who has the call, sometimes another one (rejected).
  const judge: Actor = {
    kind: 'judge',
    user: (d % 5 ? call?.claimedBy : undefined) ?? `j${a % 2}`,
  };
  const id = call?.id ?? 'c0';
  const target = state.seats[d % state.seats.length]?.id ?? 'A';
  const rulings: Ruling[] = [
    { kind: 'answered' },
    { kind: 'escalate' },
    { kind: 'pass-for', seat: call?.seat ?? impulseHolder(state) ?? target },
    {
      kind: 'extend-deadline',
      seat:
        (deadlines(state).find((x) => x.seat === call?.seat) ?? deadlines(state)[0])?.seat ??
        target,
      hours: 1 + (c % 3),
    },
    { kind: 'extend-time', minutes: 1 + (c % 15) },
    { kind: 'disqualify', seat: target },
  ];
  switch (kind % 9) {
    case 0:
    case 1:
      return [
        { type: 'SetPresence', seat: seat?.id ?? 'A', present: c % 3 !== 0 },
        { kind: 'system' },
      ];
    case 2:
      return [{ type: 'Pause', minutes: 1 + (c % 6) }, d % 4 ? player : judge];
    case 3:
      return [{ type: 'Resume' }, d % 2 ? player : judge];
    case 4:
      return [
        {
          type: 'CallJudge',
          reason: PLAYER_CALL_REASONS[c % PLAYER_CALL_REASONS.length] ?? 'rules',
          ...(d % 2 ? { seat: target } : {}),
          ...(d % 3 === 0 ? { note: 'n' } : {}),
        },
        player,
      ];
    case 5:
      return [{ type: 'ClaimJudgeCall', id }, judge];
    case 6:
      // Rare in play, so ask for it directly: a judge disqualifies (tournament games only).
      return [
        { type: 'ResolveJudgeCall', id, ruling: { kind: 'disqualify', seat: target } },
        judge,
      ];
    case 7: {
      // More time for an away player: call a judge about them first if nobody has.
      const away = deadlines(state)[0]?.seat;
      if (call || !away) {
        return [{ type: 'ResolveJudgeCall', id, ruling: rulings[3] as Ruling }, judge];
      }
      const caller = state.seats.find((s) => s.id !== away && !s.ousted)?.occupant ?? '';
      return [
        { type: 'CallJudge', reason: 'slow-play', seat: away },
        { kind: 'player', user: caller },
      ];
    }
    default: {
      // Rulings that fit the call more often than not.
      const fitting =
        call?.reason === 'deadline' ? (c % 2 ? 2 : 3) : call?.reason === 'time-limit' ? 4 : 0;
      const ruling = (d % 3 ? rulings[fitting] : rulings[c % rulings.length]) ?? rulings[0];
      return [{ type: 'ResolveJudgeCall', id, ruling: ruling as Ruling }, judge];
    }
  }
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

interface Applied {
  before: GameState;
  command: Command;
  actor: Actor;
  now: number;
  events: GameEvent[];
  after: GameState;
}

/**
 * Run random games, calling `onCommand` for every accepted command (including the server's timer
 * checks as they fall due) and `onEvent` for every applied event.
 */
function play(
  onEvent: (before: GameState, ev: GameEvent, after: GameState) => void,
  onCommand: (applied: Applied) => void = () => {},
) {
  fc.assert(
    fc.property(
      fc.integer({ min: 3, max: 5 }),
      fc.integer(),
      fc.array(fc.tuple(fc.nat(), fc.nat(), fc.nat(), fc.nat(), fc.nat(), fc.nat(), fc.nat()), {
        minLength: 20,
        maxLength: 80,
      }),
      (seatCount, seed, steps) => {
        let state = deepFreeze(start(seatCount, seed));
        const rng = seededRng(seed + 1);
        let now = T0;
        const apply = (command: Command, actor: Actor, at: number): boolean => {
          const result = decide(state, command, {
            actor,
            now: instantFromMs(at),
            rng,
            catalog,
          });
          if (!result.ok) return false;
          const before = state;
          for (const ev of result.events) {
            const after = deepFreeze(evolve(state, ev));
            onEvent(state, ev, after);
            state = after;
          }
          onCommand({ before, command, actor, now: at, events: result.events, after: state });
          return true;
        };
        for (const step of steps) {
          // Time passes; the checks the server scheduled run when they fall due, in order.
          const to = now + advance(step);
          for (;;) {
            const due = timers(state)
              .filter((t) => ms(t.at) <= to)
              .sort((x, y) => ms(x.at) - ms(y.at))[0];
            if (!due) break;
            const at = Math.max(now, ms(due.at));
            if (!apply(due.command, { kind: 'system' }, at)) {
              throw new Error(`timer ${due.key} at ${due.at} did nothing`);
            }
            now = at;
          }
          now = to;
          const pick = step[0] % 10;
          const [command, actor] =
            pick < 5
              ? guidedStep(state, step)
              : pick < 7
                ? tableStep(state, step)
                : [commandFor(state, step), actorFor(state, step)];
          apply(command, actor, now);
        }
      },
    ),
    { numRuns: 150 },
  );
}

const forEveryEvent = (check: (before: GameState, ev: GameEvent, after: GameState) => void) =>
  play(check);
const forEveryCommand = (check: (applied: Applied) => void) => play(() => {}, check);

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
      'StopsSet',
      'Held',
      'PlayerPresent',
      'PlayerAbsent',
      'Paused',
      'Resumed',
      'DeadlineReminded',
      'DeadlineExpired',
      'TimeLimitReached',
      'DeadlineExtended',
      'TimeExtended',
      'JudgeCalled',
      'JudgeCallClaimed',
      'JudgeCallResolved',
      'Ousted',
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
  it('an active game always waits on someone still in it, and knows since when (UX-09)', () => {
    // Checked once each command is done: an oust of the acting seat passes the turn in later
    // events of the same command.
    forEveryCommand(({ command, after }) => {
      const waits = waitingOn(after);
      if (after.status !== 'active') return;
      expect(waits.length, `nobody to wait on after ${command.type}`).toBeGreaterThan(0);
      for (const w of waits) {
        const seat = after.seats.find((s) => s.id === w.seat);
        expect(seat && !seat.ousted && !seat.withdrawn, `${w.seat} is out`).toBe(true);
      }
    });
    forEveryEvent((_, __, after) => {
      if (after.status !== 'active') return;
      expect(after.waiting?.key ?? '').toBe(waitKey(after));
      if (after.waiting) expect(after.waiting.seq).toBeLessThanOrEqual(after.seq);
    });
  });

  it('evolve never mutates its input (states are deep-frozen) and blood is conserved by transfers', () => {
    forEveryEvent((before, ev, after) => {
      if (ev.type === 'BloodTransferred') expect(totalBlood(after)).toBe(totalBlood(before));
      expect(after.seq).toBe(ev.seq);
    });
  });
});

const TIMER_EVENTS: Record<string, readonly string[]> = {
  CheckDeadline: ['DeadlineReminded', 'DeadlineExpired', 'JudgeCalled'],
  CheckTimeLimit: ['TimeLimitReached', 'JudgeCalled'],
  EndPause: ['Resumed'],
};
const ALLOWED_WHILE_PAUSED = new Set([
  'Resume',
  'SetAutoPass',
  'SetStops',
  'ReplacePlayer',
  'CallJudge',
  'ClaimJudgeCall',
  'ResolveJudgeCall',
  'SetPresence',
  'CheckDeadline',
  'CheckTimeLimit',
  'EndPause',
]);

describe('time and judges', { timeout: 60_000 }, () => {
  it('the clock runs exactly when it should, never goes back, and never outruns real time', () => {
    forEveryEvent((before, ev, after) => {
      if (!after.clock) return;
      expect(!!after.clock.runningSince, `after ${ev.type}`).toBe(clockRunning(after));
      const elapsed = clockElapsed(after, ev.at);
      expect(elapsed).toBeGreaterThanOrEqual(clockElapsed(before, ev.at));
      expect(elapsed).toBeLessThanOrEqual(ms(ev.at) - T0);
    });
  });

  it('no player pauses for more than their allowance in a game', () => {
    forEveryEvent((_, __, after) => {
      for (const s of after.seats) {
        // Rounded to the nearest minute, so up to half a minute over.
        expect(s.pausedMs ?? 0).toBeLessThanOrEqual(MAX_PAUSE_TOTAL_MINUTES * MINUTE_MS + 30_000);
      }
    });
  });

  it('a pause stops play: only settings, judges and the server act while paused', () => {
    forEveryCommand(({ before, command }) => {
      if (before.pause) expect(ALLOWED_WHILE_PAUSED, command.type).toContain(command.type);
    });
  });

  it('a timer check only reminds, flags and calls a judge; it never acts for a player (DQ6)', () => {
    forEveryCommand(({ command, events }) => {
      const allowed = TIMER_EVENTS[command.type];
      if (!allowed) return;
      for (const ev of events) expect(allowed, `${command.type} → ${ev.type}`).toContain(ev.type);
    });
  });

  it('a timer that fires early, or twice, does nothing', () => {
    forEveryCommand(({ after, now }) => {
      for (const t of timers(after)) {
        const at = ms(t.at);
        expect(Number.isNaN(at), t.key).toBe(false);
        if (at <= now) continue;
        const early = decide(after, t.command, {
          actor: { kind: 'system' },
          now: instantFromMs(now),
          rng: seededRng(0),
          catalog,
        });
        expect(early.ok, `${t.key} fired early`).toBe(false);
      }
    });
  });

  it('judge calls stay consistent: unique, one per player, deadline calls still overdue', () => {
    forEveryCommand(({ after }) => {
      const calls = after.judgeCalls ?? [];
      expect(new Set(calls.map((c) => c.id)).size).toBe(calls.length);
      for (const c of calls) {
        if (c.reason !== 'deadline') continue;
        expect(after.waiting?.expired ?? []).toContain(c.seat);
        expect(after.seats.some((s) => s.id === c.seat && !s.ousted)).toBe(true);
      }
      // A player has at most one call open at a time.
      const callers = calls.flatMap((c) => (c.by ? [c.by] : []));
      expect(new Set(callers).size).toBe(callers.length);
      for (const s of after.seats) if (s.disqualified) expect(s.ousted).toBeDefined();
      if (after.status !== 'active') expect(after.pause).toBeUndefined();
    });
  });
});
