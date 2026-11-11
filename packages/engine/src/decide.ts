import { type CardCatalog, type Grant, titleBallots, titleVotes } from './catalog.ts';
import {
  clockElapsed,
  deadlines,
  HOUR_MS,
  instantFromMs,
  MAX_PAUSE_MINUTES,
  MIN_TOURNAMENT_TIME_LIMIT_MS,
  MINUTE_MS,
  ms,
  pauseMinutesLeft,
  timeLimit,
} from './clock.ts';
import { combatEndsStruck, damageTaken, isVampire, pendingFrom } from './combat.ts';
import type { BloodHolder, Command } from './commands.ts';
import type { EventBody, GameEvent } from './events.ts';
import { evolve } from './evolve.ts';
import {
  combatantOf,
  combatSeats,
  eligibleBlockers,
  impulseHolder,
  isHolding,
  passesAutomatically,
  seatRefs,
} from './flow.ts';
import type {
  Actor,
  ActorRef,
  CardInstance,
  Cast,
  CombatState,
  GameEndReason,
  GameSettings,
  GameState,
  InstanceId,
  Instant,
  Override,
  PendingDamage,
  StopRule,
  ZoneId,
} from './model.ts';
import {
  ACTION_KINDS,
  COMBAT_STEPS,
  PHASES,
  PLAYER_CALL_REASONS,
  STOP_ACTORS,
  STOP_TRIGGERS,
  STRIKE_KINDS,
  type Strike,
  VOTE_SIDES,
} from './model.ts';
import { canSee } from './projection.ts';
import { tally } from './referendum.ts';
import { newInstanceId, type Rng, shuffled } from './rng.ts';
import { nextTurnSeat, predator, prey, type SeatId, windowOrder } from './seating.ts';
import {
  canWithdraw,
  FULL_HAND,
  WITHDRAWAL_VP,
  type WithdrawalBreak,
  withdrawalBreaks,
} from './withdrawal.ts';
import {
  HIDDEN_ZONES,
  IN_PLAY_ZONES,
  isHiddenZone,
  isZoneName,
  parseZoneId,
  zoneCards,
  zoneId,
} from './zones.ts';

export interface DecideContext {
  actor: Actor;
  now: Instant;
  rng: Rng;
  catalog: CardCatalog;
}

export type RejectionCode =
  | 'forbidden'
  | 'not-seated'
  | 'invalid'
  | 'unknown-card'
  | 'unknown-seat'
  | 'hidden'
  | 'not-enough'
  | 'no-change'
  | 'wrong-status'
  | 'not-now';

export interface Rejection {
  code: RejectionCode;
  message: string;
}

export type DecideResult = { ok: true; events: GameEvent[] } | { ok: false; rejection: Rejection };

class Rejected extends Error {
  constructor(readonly rejection: Rejection) {
    super(rejection.message);
  }
}

function reject(code: RejectionCode, message: string): never {
  throw new Rejected({ code, message });
}

/**
 * Validate a command against the current state and turn it into events (architecture §4.2).
 * Permissions follow GAME-10: players may change anything on their own zones and anything public;
 * other players' hidden zones are off limits. Judges may use every primitive (audited through the
 * event's `by`), admins may only replace players and end games, and the system starts games.
 * docs/roles.md lists every role's powers.
 */
export function decide(state: GameState, cmd: Command, ctx: DecideContext): DecideResult {
  try {
    const by = actorRef(state, cmd, ctx.actor);
    const ids = idSource(state, ctx.rng);
    const dq =
      cmd.type === 'ResolveJudgeCall' && cmd.ruling.kind === 'disqualify'
        ? cmd.ruling.seat
        : undefined;
    const bodies = withGameEnd(
      state,
      settleCalls(
        state,
        withWithdrawals(
          state,
          withOusts(
            state,
            bodiesFor(state, cmd, ctx, by, ids),
            ctx.now,
            by,
            { ids, catalog: ctx.catalog },
            dq,
          ),
          ctx.now,
          by,
        ),
        ctx.now,
        by,
      ),
      ctx.now,
      by,
    );
    return {
      ok: true,
      events: bodies.map(
        (body, i): GameEvent => ({ ...body, seq: state.seq + i + 1, at: ctx.now, by }),
      ),
    };
  } catch (e) {
    if (e instanceof Rejected) return { ok: false, rejection: e.rejection };
    throw e;
  }
}

/** Commands only the server issues, for the system actor. */
const SYSTEM_COMMANDS: ReadonlySet<Command['type']> = new Set([
  'SetPresence',
  'CheckDeadline',
  'CheckTimeLimit',
  'EndPause',
]);

const ALLOWED_WHILE_PAUSED: ReadonlySet<Command['type']> = new Set([
  'Resume',
  'SetAutoPass',
  'SetStops',
  'ReplacePlayer',
  'CallJudge',
  'ClaimJudgeCall',
  'ResolveJudgeCall',
  'EndGame',
  'ProposeEnd',
  'AgreeEnd',
  'DeclineEnd',
]);

const MAX_CALL_NOTE = 500;
/** A note on a strike or a card used. */
const MAX_NOTE = 200;

function actorRef(state: GameState, cmd: Command, actor: Actor): ActorRef {
  if (cmd.type === 'StartGame') {
    if (actor.kind !== 'system') reject('forbidden', 'Only the system starts games');
    if (state.status !== 'setup') reject('wrong-status', 'The game has already started');
    return { kind: 'system' };
  }
  if (state.status !== 'active') reject('wrong-status', 'The game is not in progress');
  if (cmd.type === 'ReplacePlayer') {
    if (actor.kind !== 'admin') reject('forbidden', 'Only admins can replace players');
    return { kind: 'admin', user: actor.user };
  }
  if (cmd.type === 'EndGame') {
    if (actor.kind !== 'admin') {
      reject('forbidden', 'Only admins end games; players of a casual game can agree to end it');
    }
    return { kind: 'admin', user: actor.user };
  }
  if (SYSTEM_COMMANDS.has(cmd.type)) {
    if (actor.kind !== 'system') reject('forbidden', 'Only the server does that');
    return { kind: 'system' };
  }
  // A pause stops play; settings can still change, and a judge or the pauser can lift it.
  if (state.pause && !ALLOWED_WHILE_PAUSED.has(cmd.type)) {
    reject('not-now', 'The game is paused');
  }
  if (cmd.type === 'JudgeReveal' && actor.kind !== 'judge') {
    reject('forbidden', 'Only judges can look at hidden cards');
  }
  if (
    (cmd.type === 'ClaimJudgeCall' || cmd.type === 'ResolveJudgeCall') &&
    actor.kind !== 'judge'
  ) {
    reject('forbidden', 'Only judges answer judge calls');
  }
  switch (actor.kind) {
    case 'judge':
      return { kind: 'judge', user: actor.user };
    case 'player': {
      const seat = state.seats.find((s) => s.occupant === actor.user && !s.ousted && !s.withdrawn);
      if (!seat) reject('not-seated', 'You are not playing in this game');
      return { kind: 'seat', seat: seat.id };
    }
    default:
      return reject('forbidden', 'Not allowed');
  }
}

function bodiesFor(
  state: GameState,
  cmd: Command,
  ctx: DecideContext,
  by: ActorRef,
  ids: () => InstanceId,
): EventBody[] {
  const mySeat = by.kind === 'seat' ? by.seat : undefined;

  const card = (id: InstanceId): CardInstance =>
    state.cards[id] ?? reject('unknown-card', `No card ${id}`);
  /** A card the actor may change: anything in their own zones or in a public zone. */
  const touchable = (id: InstanceId): CardInstance => {
    const c = card(id);
    if (mySeat !== undefined && isHiddenZone(c.zone) && parseZoneId(c.zone).seat !== mySeat) {
      reject('hidden', "That card is in another player's hidden zone");
    }
    return c;
  };
  const inPublicZone = (c: CardInstance, alsoUncontrolled = false) => {
    const { name } = parseZoneId(c.zone);
    if (HIDDEN_ZONES.has(name) && !(alsoUncontrolled && name === 'uncontrolled')) {
      reject('invalid', 'That card is not in play');
    }
  };
  const seat = (id: SeatId) =>
    state.seats.find((s) => s.id === id) ?? reject('unknown-seat', `No seat ${id}`);
  /** A seat still in the game: an ousted or withdrawn one can't be acted on (GAME-08). */
  const liveSeat = (id: SeatId) => {
    const s = seat(id);
    if (s.ousted || s.withdrawn) reject('invalid', 'That player is out of the game');
    return s;
  };
  const openCall = (id: string) =>
    state.judgeCalls?.find((c) => c.id === id) ?? reject('invalid', `No open judge call ${id}`);
  const ownSeatOrJudge = (id: SeatId) => {
    liveSeat(id);
    if (mySeat !== undefined && id !== mySeat) reject('forbidden', "That is another player's zone");
  };
  const nonZero = (n: number, step = 1) => {
    if (!Number.isFinite(n) || n === 0 || !Number.isInteger(n / step)) {
      reject('invalid', `Invalid amount: ${n}`);
    }
  };

  const holdingImpulse = (): SeatId => {
    const s = mySeat ?? reject('not-seated', 'Only players hold the impulse');
    if (!state.window) reject('not-now', 'Nobody has the impulse right now');
    if (impulseHolder(state) !== s) reject('not-now', 'It is not your impulse');
    return s;
  };
  /** One of `s`'s minions, ready to act or block: in their ready region, not attached. */
  const readyMinion = (id: InstanceId, s: SeatId): CardInstance => {
    const m = card(id);
    if (m.zone !== zoneId(s, 'ready') || m.attachedTo !== undefined) {
      reject('invalid', 'Choose one of your minions in your ready region');
    }
    return m;
  };
  /** Whether the catalog says the card lifts the rule. */
  const hasGrant = (c: CardInstance | undefined, grant: Grant): boolean =>
    !!c?.cardId && !!ctx.catalog.get(c.cardId)?.grants?.includes(grant);
  /** A public override source: a face-up card the seat controls in play. */
  const faceUpInPlay = (c: CardInstance, s: SeatId): boolean =>
    c.controller === s && IN_PLAY_ZONES.has(parseZoneId(c.zone).name) && !c.faceDown;
  const overrideFrom = (grant: Grant, source: CardInstance | undefined): Override =>
    withOptional(
      { grant, verified: hasGrant(source, grant) },
      { source: source?.id, sourceCardId: source?.cardId },
    );
  /** The action in progress, which the actor (its Methuselah or a judge) may steer. */
  const actingAction = () => {
    const a = state.action ?? reject('not-now', 'No action in progress');
    if (mySeat !== undefined && mySeat !== a.seat) reject('forbidden', 'It is not your action');
    return a;
  };
  /**
   * A master card put on another Methuselah's minion stays under the control of whoever put it
   * there; any other card is controlled by the seat whose zone it is in (VTES rulebook, control).
   */
  const controllerOn = (c: CardInstance, by: SeatId, zone: ZoneId): SeatId | undefined => {
    const master = !!c.cardId && (ctx.catalog.get(c.cardId)?.types ?? []).includes('Master');
    return master && parseZoneId(zone).seat !== by ? by : undefined;
  };
  /**
   * Cards attach to the card at the bottom of a stack, never to another attached card: naming an
   * attached card means its host.
   */
  const rootOf = (c: CardInstance): CardInstance => {
    let h = c;
    for (let n = 0; h.attachedTo !== undefined && n < 100; n++) {
      const next = state.cards[h.attachedTo];
      if (!next) break;
      h = next;
    }
    return h;
  };
  const hasAttachments = (c: CardInstance) =>
    Object.values(state.cards).some((x) => x.attachedTo === c.id);
  const played = (c: CardInstance, to: ZoneId, replace: boolean, controller?: SeatId) =>
    playedFromHand(state, ids, c, to, replace, controller);
  const finishActionCard = (
    a: NonNullable<GameState['action']>,
    outcome: 'success' | 'failure' | 'blocked',
  ) => finishedActionCard(state, ids, a, outcome);
  /**
   * The impulse back to the acting side after a play (rulebook, "Impulse"): the acting Methuselah,
   * in combat the acting minion's, who may play again; the passes so far are voided. In a
   * referendum's polling the impulse stays with whoever did something (architecture §4.4, R3).
   */
  const impulseBack = (): EventBody =>
    state.window?.kind === 'polling'
      ? withOptional({ type: 'ImpulseReset' } as const, { to: impulseHolder(state) })
      : { type: 'ImpulseReset' };

  /** The combat in progress, with the step open, and the sender's combatant holding the impulse. */
  const combatTurn = () => {
    const s = holdingImpulse();
    const c = state.action?.combat;
    if (state.window?.kind !== 'combat' || !c) reject('not-now', 'There is no combat step open');
    const minion =
      combatantOf(state, s) ?? reject('forbidden', 'You have no minion in this combat');
    return { s, c, minion };
  };
  /**
   * Where a combat move comes from (docs/flow.md, "Combat"): a card in the hand is played with it
   * (to the ash heap, and replaced); a face-up card in play is only named.
   */
  const combatSource = (
    id: InstanceId | undefined,
    s: SeatId,
  ): { source?: CardInstance; played: boolean; with: (move: EventBody) => EventBody[] } => {
    if (id === undefined) return { played: false, with: (move) => [move] };
    const c = card(id);
    if (c.zone === zoneId(s, 'hand')) {
      if (state.action?.card === c.id) reject('invalid', 'That card is part of the current action');
      const [play, ...rest] = played(c, zoneId(s, 'ashHeap'), true);
      const shown = {
        ...(play as Extract<EventBody, { type: 'CardMoved' }>),
        source: true as const,
      };
      // Played first, so the card is public when the move names it; replaced after.
      return { source: c, played: true, with: (move) => [shown, move, ...rest] };
    }
    if (!faceUpInPlay(c, s)) {
      reject('invalid', 'Name a card in your hand or one of your face-up cards in play');
    }
    return { source: c, played: false, with: (move) => [move] };
  };
  const settle = (from: GameState, bodies: EventBody[]) =>
    settleWindow(from, bodies, ctx.now, by, { ids, catalog: ctx.catalog });

  switch (cmd.type) {
    case 'StartGame':
      return [startGame(cmd, ctx.catalog, ctx.rng, ids)];

    case 'MoveCard': {
      const c = touchable(cmd.card);
      const { seat: toSeat, name: toName } = parseZoneId(cmd.to);
      // Cards an ousted player owns may still leave play into their ash heap.
      if (!(toName === 'ashHeap' && toSeat === c.owner)) liveSeat(toSeat);
      else seat(toSeat);
      if (!isZoneName(toName)) reject('invalid', `No zone ${toName}`);
      const toHidden = HIDDEN_ZONES.has(toName);
      if (toHidden && toSeat !== c.owner) {
        reject(
          'invalid',
          "Cards can only go into their owner's crypt, library, hand or uncontrolled region",
        );
      }
      const fromHidden = isHiddenZone(c.zone);
      const faceDown = toHidden ? false : (cmd.faceDown ?? (fromHidden ? false : c.faceDown));
      if (c.zone === cmd.to && !toHidden && faceDown === c.faceDown) {
        reject('no-change', 'The card is already there');
      }
      const position =
        cmd.position ?? (toName === 'library' || toName === 'crypt' ? 'top' : 'bottom');
      const rekey = toHidden || (faceDown && !(c.faceDown && !fromHidden));
      return [
        withOptional(
          { type: 'CardMoved', card: c.id, from: c.zone, to: cmd.to, position, faceDown },
          { newId: rekey ? ids() : undefined, cardId: c.cardId },
        ),
      ];
    }

    case 'Draw': {
      const s = cmd.seat ?? mySeat ?? reject('invalid', 'Which seat draws?');
      ownSeatOrJudge(s);
      const from = cmd.from ?? 'library';
      const count = cmd.count ?? 1;
      if (!Number.isInteger(count) || count < 1) reject('invalid', `Invalid count: ${count}`);
      const top = zoneCards(state, zoneId(s, from)).slice(0, count);
      if (top.length < count) reject('not-enough', `Only ${top.length} cards in the ${from}`);
      return [
        {
          type: 'CardsDrawn',
          seat: s,
          from,
          cards: top.map((id) => withOptional({ id, newId: ids() }, { cardId: card(id).cardId })),
        },
      ];
    }

    case 'Shuffle': {
      const { seat: s, name } = parseZoneId(cmd.zone);
      ownSeatOrJudge(s);
      if (name !== 'crypt' && name !== 'library' && name !== 'hand') {
        reject('invalid', 'Only a crypt, library or hand can be shuffled');
      }
      const from = shuffled(zoneCards(state, cmd.zone), ctx.rng);
      return [{ type: 'ZoneShuffled', zone: cmd.zone, ids: from.map(() => ids()), from }];
    }

    case 'Flip': {
      const c = touchable(cmd.card);
      inPublicZone(c);
      const faceDown = !c.faceDown;
      return [
        withOptional(
          { type: 'CardFlipped', card: c.id, faceDown },
          { newId: faceDown ? ids() : undefined, cardId: c.cardId },
        ),
      ];
    }

    case 'SetLocked': {
      const c = touchable(cmd.card);
      inPublicZone(c);
      if (c.locked === cmd.locked)
        reject('no-change', `Already ${cmd.locked ? 'locked' : 'unlocked'}`);
      return [{ type: 'CardLocked', card: c.id, locked: cmd.locked }];
    }

    case 'SetContested': {
      const c = touchable(cmd.card);
      inPublicZone(c);
      if (c.contested === cmd.contested) reject('no-change', 'No change');
      return [{ type: 'CardContested', card: c.id, contested: cmd.contested }];
    }

    case 'AdjustCounter': {
      const c = touchable(cmd.card);
      inPublicZone(c, true);
      nonZero(cmd.delta);
      if ((c.counters[cmd.counter] ?? 0) + cmd.delta < 0) {
        reject('not-enough', `Not enough ${cmd.counter} counters`);
      }
      return [{ type: 'CounterAdjusted', card: c.id, counter: cmd.counter, delta: cmd.delta }];
    }

    case 'AdjustPool': {
      const s = liveSeat(cmd.seat);
      nonZero(cmd.delta);
      if (s.pool + cmd.delta < 0) reject('not-enough', 'Pool cannot go below zero');
      return [{ type: 'PoolAdjusted', seat: s.id, delta: cmd.delta }];
    }

    case 'AdjustVp': {
      const s = seat(cmd.seat);
      nonZero(cmd.delta, 0.5);
      if (s.vp + cmd.delta < 0) reject('not-enough', 'Victory points cannot go below zero');
      return [{ type: 'VpAdjusted', seat: s.id, delta: cmd.delta }];
    }

    case 'TransferBlood': {
      if (!Number.isInteger(cmd.amount) || cmd.amount < 1)
        reject('invalid', `Invalid amount: ${cmd.amount}`);
      const available = (h: BloodHolder) => {
        if ('pool' in h) return liveSeat(h.pool).pool;
        const c = touchable(h.card);
        inPublicZone(c, true);
        return c.counters.blood ?? 0;
      };
      if (JSON.stringify(cmd.from) === JSON.stringify(cmd.to))
        reject('invalid', 'Source and destination are the same');
      if (available(cmd.from) < cmd.amount) reject('not-enough', 'Not enough blood');
      available(cmd.to);
      return [{ type: 'BloodTransferred', from: cmd.from, to: cmd.to, amount: cmd.amount }];
    }

    case 'Attach': {
      const c = touchable(cmd.card);
      if (cmd.to === undefined) {
        if (c.attachedTo === undefined) reject('no-change', 'The card is not attached');
        return [{ type: 'CardAttached', card: c.id }];
      }
      const host = rootOf(touchable(cmd.to));
      if (!IN_PLAY_ZONES.has(parseZoneId(host.zone).name))
        reject('invalid', 'The host is not in play');
      if (host.id !== c.id && hasAttachments(c)) reject('invalid', 'Detach the cards on it first');
      for (
        let h: CardInstance | undefined = host;
        h;
        h = h.attachedTo ? state.cards[h.attachedTo] : undefined
      ) {
        if (h.id === c.id) reject('invalid', 'A card cannot be attached to itself');
      }
      if (c.attachedTo === host.id) reject('no-change', 'Already attached');
      const bodies: EventBody[] = [];
      if (c.zone !== host.zone) {
        bodies.push(
          withOptional(
            {
              type: 'CardMoved',
              card: c.id,
              from: c.zone,
              to: host.zone,
              position: 'bottom',
              faceDown: false,
            },
            { cardId: c.cardId, controller: controllerOn(c, c.controller, host.zone) },
          ),
        );
      }
      bodies.push({ type: 'CardAttached', card: c.id, to: host.id });
      return bodies;
    }

    case 'Reveal': {
      const c = card(cmd.card);
      const { seat: s, name } = parseZoneId(c.zone);
      const own =
        mySeat !== undefined &&
        (((name === 'hand' || name === 'uncontrolled') && s === mySeat) ||
          (c.faceDown && c.owner === mySeat));
      if (!own) reject('forbidden', 'You can only reveal your own hidden cards');
      return [withOptional({ type: 'CardRevealed', card: c.id }, { cardId: c.cardId })];
    }

    case 'JudgeReveal': {
      const c = card(cmd.card);
      if (canSee(c, { kind: 'judge' }))
        reject('no-change', 'The card is already visible to judges');
      return [withOptional({ type: 'JudgeRevealed', card: c.id }, { cardId: c.cardId })];
    }

    case 'SetEdge': {
      if (cmd.seat !== undefined) liveSeat(cmd.seat);
      if (state.seats.find((s) => s.hasEdge)?.id === cmd.seat) reject('no-change', 'No change');
      return [withOptional({ type: 'EdgeSet' }, { seat: cmd.seat })];
    }

    case 'SetTurnDirection':
      if (state.turnDirection === cmd.direction) reject('no-change', 'No change');
      return [{ type: 'TurnDirectionSet', direction: cmd.direction }];

    case 'AdvancePhase': {
      const turn = state.turn ?? reject('wrong-status', 'No turn in progress');
      if (mySeat !== undefined && mySeat !== turn.seat) reject('forbidden', 'It is not your turn');
      if (state.action) reject('not-now', 'Finish the current action first');
      if (state.window) {
        // Judges can cut a stuck pass round short.
        if (mySeat !== undefined) reject('not-now', 'Waiting for the other players to pass');
        return [{ type: 'WindowClosed' }, ...advancePhase(state)];
      }
      const order = windowOrder(seatRefs(state), turn.seat, 'undirected');
      const opened: EventBody = {
        type: 'WindowOpened',
        window: { kind: 'phase', phase: turn.phase, order, cursor: 1 % order.length, passes: 1 },
      };
      const probe = applyBodies(state, [opened], ctx.now, by);
      // Skip the round entirely when nobody would stop it.
      if (order.slice(1).every((s) => passesAutomatically(probe, s))) return advancePhase(state);
      return settle(state, [opened]);
    }

    case 'SetAutoPass': {
      const s = mySeat ?? reject('not-seated', 'Only players have auto-pass settings');
      const phases = PHASES.filter((p) => cmd.phases.includes(p));
      if (phases.length !== new Set(cmd.phases).size) reject('invalid', 'Unknown phase');
      return settle(state, [{ type: 'AutoPassSet', seat: s, phases }]);
    }

    case 'SetStops': {
      const s = mySeat ?? reject('not-seated', 'Only players have stops');
      const stops: StopRule[] = [];
      for (const r of cmd.stops) {
        if (!STOP_TRIGGERS.includes(r.on)) reject('invalid', `Unknown stop ${r.on}`);
        if (!STOP_ACTORS.includes(r.actors)) reject('invalid', `Unknown stop scope ${r.actors}`);
        const rule: StopRule = { on: r.on, actors: r.actors };
        if (!stops.some((x) => JSON.stringify(x) === JSON.stringify(rule))) stops.push(rule);
      }
      return settle(state, [{ type: 'StopsSet', seat: s, stops }]);
    }

    case 'Hold': {
      const s = mySeat ?? reject('not-seated', 'Only players hold windows');
      const w = state.window ?? reject('not-now', 'There is nothing to hold');
      if (!w.order.includes(s)) reject('forbidden', 'You are not part of this window');
      if (w.kind === 'polling') reject('no-change', 'Polling always waits for everyone');
      if (w.order[0] === s) reject('no-change', 'The window always waits for you');
      if (impulseHolder(state) === s) reject('no-change', 'You already have the impulse');
      if (isHolding(state, s)) reject('no-change', 'You are already holding');
      return settle(state, [{ type: 'Held', seat: s }]);
    }

    case 'DeclareAction': {
      const s = mySeat ?? reject('not-seated', 'Only the acting player declares actions');
      const turn = state.turn;
      if (turn?.seat !== s) reject('forbidden', 'It is not your turn');
      if (turn.phase !== 'minion') reject('not-now', 'Actions are taken in the minion phase');
      if (state.action) reject('not-now', 'Another action is in progress');
      if (state.window) reject('not-now', 'Waiting for the other players to pass');
      if (!ACTION_KINDS.includes(cmd.kind)) reject('invalid', `Unknown action ${cmd.kind}`);
      const minion = readyMinion(cmd.minion, s);
      if (minion.locked) reject('invalid', 'Locked minions cannot act; unlock it first if allowed');
      let target = cmd.target === s ? undefined : cmd.target;
      if (target !== undefined) {
        const t = seat(target);
        if (t.ousted || t.withdrawn) reject('invalid', 'That player is out of the game');
      }
      let actionCard: CardInstance | undefined;
      if (cmd.card !== undefined) {
        actionCard = card(cmd.card);
        if (actionCard.zone !== zoneId(s, 'hand')) {
          reject('invalid', 'The action card must be in your hand');
        }
      }
      const cardId = actionCard?.cardId;
      let override: Override | undefined;
      if (cmd.kind === 'bleed') {
        const myPrey = prey(seatRefs(state), s);
        target ??= myPrey ?? reject('invalid', 'There is nobody to bleed');
        // Bleeding anyone but your prey needs a card effect (docs/flow.md, "Overrides").
        if (target !== myPrey) {
          let source = actionCard;
          const claimed = cmd.override?.source;
          if (claimed !== undefined && claimed !== cmd.card) {
            source = card(claimed);
            if (!faceUpInPlay(source, s)) {
              reject(
                'invalid',
                'The card that allows it must be the action card or one of your face-up cards in play',
              );
            }
          }
          if (!cmd.override && !hasGrant(actionCard, 'bleed-any')) {
            reject(
              'forbidden',
              'You can only bleed your prey. Name the card that lets you bleed another Methuselah',
            );
          }
          if (!source && state.settings.tournament) {
            reject(
              'forbidden',
              'In tournament games, name the card that lets you bleed another Methuselah',
            );
          }
          override = overrideFrom('bleed-any', source);
        }
      }
      const bodies: EventBody[] = [{ type: 'CardLocked', card: minion.id, locked: true }];
      bodies.push({
        type: 'ActionDeclared',
        action: withOptional(
          {
            seat: s,
            minion: minion.id,
            kind: cmd.kind,
            eligible: eligibleBlockers(state, s, target),
            declined: [],
            stage: 'blocks' as const,
          },
          { target, card: cmd.card, cardId, override },
        ),
      });
      const order = windowOrder(
        seatRefs(state),
        s,
        target === undefined ? 'undirected' : { directedAt: target },
      );
      // Declaring counts as the acting Methuselah's first pass.
      bodies.push({
        type: 'WindowOpened',
        window: { kind: 'blocks', phase: 'minion', order, cursor: 1 % order.length, passes: 1 },
      });
      return settle(state, bodies);
    }

    case 'Pass': {
      const s = holdingImpulse();
      const c = state.action?.combat;
      if (state.window?.kind === 'combat' && c?.step === 'strikes') {
        const minion = combatantOf(state, s);
        const sitsOut = !!c.exchange && minion !== undefined && !c.exchange.includes(minion);
        if (minion !== undefined && !sitsOut && !c.strikes.some((x) => x.minion === minion)) {
          reject('not-now', 'Choose a strike first (or no strike)');
        }
      }
      return settle(state, [{ type: 'Passed', seat: s }]);
    }

    case 'Block': {
      const s = holdingImpulse();
      const a = state.action;
      if (state.window?.kind !== 'blocks' || !a) reject('not-now', 'There is nothing to block');
      if (a.seat === s) reject('forbidden', 'You cannot block your own action');
      // A decision not to block stands, whatever card effect comes later.
      if (a.declined.includes(s)) reject('forbidden', 'You already declined to block this action');
      if (a.blockAttempt) reject('not-now', 'A block attempt is already pending');
      const minion = readyMinion(cmd.minion, s);
      // Only ready unlocked minions block (rulebook, "Locking and Unlocking").
      if (minion.locked)
        reject('invalid', 'Locked minions cannot block; unlock it first if allowed');
      if (a.eligible.includes(s)) {
        return settle(state, [{ type: 'BlockAttempted', seat: s, minion: minion.id }]);
      }
      // Not an eligible blocker: only a card effect lets you (docs/flow.md, "Overrides").
      if (!cmd.override) {
        reject(
          'forbidden',
          'You are not an eligible blocker. Name the card that lets you block this action',
        );
      }
      const bodies: EventBody[] = [];
      let source: CardInstance | undefined;
      if (cmd.override.source !== undefined) {
        source = card(cmd.override.source);
        if (source.zone === zoneId(s, 'hand')) {
          // A card from the hand is played with the attempt, so it is public from here on.
          bodies.push(...played(source, zoneId(s, 'ashHeap'), true));
        } else if (!faceUpInPlay(source, s)) {
          reject(
            'invalid',
            'The card that allows it must be in your hand or one of your face-up cards in play',
          );
        }
      } else if (state.settings.tournament) {
        reject('forbidden', 'In tournament games, name the card that lets you block this action');
      }
      bodies.push({
        type: 'BlockAttempted',
        seat: s,
        minion: minion.id,
        override: overrideFrom('block-any', source),
      });
      return settle(state, bodies);
    }

    case 'WithdrawBlock': {
      const attempt = state.action?.blockAttempt ?? reject('not-now', 'No block attempt pending');
      if (mySeat !== undefined && mySeat !== attempt.seat) {
        reject('forbidden', 'Only the blocking player can withdraw the block');
      }
      const bodies: EventBody[] = [{ type: 'BlockWithdrawn', seat: attempt.seat }];
      // Withdrawing on your own impulse passes it on.
      if (impulseHolder(state) === attempt.seat)
        bodies.push({ type: 'Passed', seat: attempt.seat });
      return settle(state, bodies);
    }

    case 'PlayCard': {
      const s = mySeat ?? reject('not-seated', 'Only players play cards');
      const c = card(cmd.card);
      if (c.zone !== zoneId(s, 'hand')) reject('invalid', 'You can only play cards from your hand');
      if (state.action?.card === c.id) reject('invalid', 'That card is part of the current action');
      if (state.window && impulseHolder(state) !== s) {
        reject('not-now', 'Wait for the impulse to play a card');
      }
      let to = zoneId(s, cmd.to ?? 'ashHeap');
      const attachTo = cmd.attachTo === undefined ? undefined : rootOf(touchable(cmd.attachTo)).id;
      if (attachTo !== undefined) {
        const host = card(attachTo);
        if (!IN_PLAY_ZONES.has(parseZoneId(host.zone).name))
          reject('invalid', 'The host is not in play');
        to = host.zone;
      }
      const controller = attachTo === undefined ? undefined : controllerOn(c, s, to);
      const bodies: EventBody[] = played(c, to, cmd.replace ?? true, controller);
      if (attachTo !== undefined)
        bodies.splice(1, 0, { type: 'CardAttached', card: c.id, to: attachTo });
      if (state.window) bodies.push(impulseBack());
      return settle(state, bodies);
    }

    case 'ResolveAction': {
      const a = actingAction();
      if (a.stage !== 'resolution') reject('not-now', 'The action is not ready to resolve');
      if (cmd.outcome === 'combat') {
        // An action that enters combat (docs/flow.md, "Combat"): the acting minion fights another.
        const opponent = card(cmd.opponent ?? reject('invalid', 'Which minion does it fight?'));
        const acting = card(a.minion);
        if (opponent.id === acting.id) reject('invalid', 'A minion cannot fight itself');
        if (acting.zone !== zoneId(acting.controller, 'ready')) {
          reject('invalid', 'The acting minion is no longer ready');
        }
        if (
          opponent.zone !== zoneId(opponent.controller, 'ready') ||
          opponent.attachedTo !== undefined
        ) {
          reject('invalid', 'Choose a minion in a ready region');
        }
        if (opponent.controller === acting.controller) {
          reject('invalid', 'Choose a minion another Methuselah controls');
        }
        return settle(state, combatOpening(state, 'action', acting.id, opponent.id));
      }
      if (cmd.outcome === 'success' && a.kind === 'political') {
        const terms = cmd.terms?.trim();
        if (terms && terms.length > MAX_NOTE) reject('invalid', 'The terms are too long');
        const m = state.cards[a.minion];
        // A vampire no longer ready calls no referendum; the action still succeeds (rules-qa 5.9).
        if (!m || m.zone !== zoneId(m.controller, 'ready')) {
          return [
            { type: 'ReferendumResolved', passed: false, for: 0, against: 0, reason: 'not-ready' },
            ...finishActionCard(a, 'success'),
            { type: 'ActionEnded', outcome: 'success' },
          ];
        }
        // The cards played before votes: the caller's left first, the caller last (rules-qa 64.12).
        const order = windowOrder(seatRefs(state), a.seat, { directedAt: a.seat });
        return settle(state, [
          withOptional({ type: 'ReferendumCalled' } as const, { terms: terms || undefined }),
          {
            type: 'WindowOpened',
            window: { kind: 'referendum', phase: 'minion', order, cursor: 1, passes: 0 },
          },
        ]);
      }
      const amount = cmd.amount ?? 1;
      if (!Number.isInteger(amount) || amount < 0) reject('invalid', `Invalid amount: ${amount}`);
      const bodies: EventBody[] = [];
      if (cmd.outcome === 'success' && a.kind === 'bleed' && a.target !== undefined) {
        const loss = Math.min(amount, seat(a.target).pool);
        if (loss > 0) bodies.push({ type: 'PoolAdjusted', seat: a.target, delta: -loss });
        // Only a bleed of 1 or more is successful and takes the Edge (zero-vtes rules-qa 24.4).
        if (cmd.edge && amount > 0 && !seat(a.seat).hasEdge) {
          bodies.push({ type: 'EdgeSet', seat: a.seat });
        }
      }
      if (cmd.outcome === 'success' && a.kind === 'hunt') {
        const m = state.cards[a.minion];
        if (m && IN_PLAY_ZONES.has(parseZoneId(m.zone).name)) {
          const capacity = m.cardId ? ctx.catalog.get(m.cardId)?.capacity : undefined;
          const room = capacity === undefined ? amount : capacity - (m.counters.blood ?? 0);
          const gain = Math.min(amount, room);
          if (gain > 0)
            bodies.push({ type: 'CounterAdjusted', card: m.id, counter: 'blood', delta: gain });
        }
      }
      bodies.push(...finishActionCard(a, cmd.outcome));
      bodies.push({ type: 'ActionEnded', outcome: cmd.outcome });
      return bodies;
    }

    case 'EndCombat': {
      const a = state.action ?? reject('not-now', 'No action in progress');
      if (a.stage !== 'combat') reject('not-now', 'There is no combat');
      const blockerSeat = a.blocker ? state.cards[a.blocker]?.controller : undefined;
      const fighting = a.combat ? combatSeats(state) : [a.seat, blockerSeat];
      if (mySeat !== undefined && mySeat !== a.seat && !fighting.includes(mySeat)) {
        reject('forbidden', 'Only the players in combat can end it');
      }
      return combatEnd(state, ids);
    }

    case 'Maneuver': {
      const { s, c, minion } = combatTurn();
      if (c.step !== 'range') reject('not-now', 'Maneuvers come in the range step');
      if (cmd.to !== 'close' && cmd.to !== 'long') reject('invalid', `No range ${cmd.to}`);
      if (c.range === cmd.to) reject('no-change', `The range is already ${cmd.to}`);
      // A minion can't maneuver twice in a row (rulebook, "Determine Range").
      if (c.lastManeuver === minion) {
        reject('not-now', 'You maneuvered last: the other side answers first');
      }
      const src = combatSource(cmd.source, s);
      const move: EventBody = withOptional({ type: 'Maneuvered', minion, to: cmd.to } as const, {
        source: src.source?.id,
        sourceCardId: src.source?.cardId,
        played: src.played ? (true as const) : undefined,
      });
      return settle(state, [...src.with(move), impulseBack()]);
    }

    case 'Strike': {
      const { s, c, minion } = combatTurn();
      if (c.step !== 'strikes') reject('not-now', 'Strikes are chosen in the strike step');
      if (c.exchange && !c.exchange.includes(minion)) {
        reject('forbidden', 'You have no additional strike');
      }
      if (c.strikes.some((x) => x.minion === minion)) {
        reject('no-change', 'You already chose a strike');
      }
      if (!STRIKE_KINDS.includes(cmd.kind)) reject('invalid', `Unknown strike ${cmd.kind}`);
      const counts = cmd.kind === 'hand' || cmd.kind === 'damage' || cmd.kind === 'steal-blood';
      const amount = counts ? (cmd.amount ?? 1) : undefined;
      if (amount !== undefined && (!Number.isInteger(amount) || amount < 0 || amount > 99)) {
        reject('invalid', `Invalid amount: ${amount}`);
      }
      const note = cmd.note?.trim();
      if (note && note.length > MAX_NOTE) reject('invalid', 'The note is too long');
      const src = combatSource(cmd.source, s);
      const strike: Strike = withOptional(
        { kind: cmd.kind },
        {
          amount,
          ranged: cmd.ranged ? (true as const) : undefined,
          aggravated: cmd.aggravated ? (true as const) : undefined,
          first: cmd.first ? (true as const) : undefined,
          source: src.source?.id,
          sourceCardId: src.source?.cardId,
          note: note || undefined,
        },
      );
      const chosen: EventBody = withOptional({ type: 'StrikeChosen', minion, strike } as const, {
        played: src.played ? (true as const) : undefined,
      });
      // Announcing a strike is the striker's pass: the other combatant chooses next.
      return settle(state, [...src.with(chosen), { type: 'Passed', seat: s, auto: true }]);
    }

    case 'Prevent': {
      const { s, c, minion } = combatTurn();
      if (c.step !== 'damage') reject('not-now', 'Damage is prevented in the damage step');
      const p = c.pending?.[minion];
      if (!p || p.normal + p.aggravated - p.prevented <= 0) {
        reject('no-change', 'There is no damage to prevent');
      }
      if (!Number.isInteger(cmd.points) || cmd.points < 1 || cmd.points > 99) {
        reject('invalid', `Invalid amount: ${cmd.points}`);
      }
      const src = combatSource(cmd.source, s);
      const prevented: EventBody = withOptional(
        { type: 'DamagePrevented', minion, points: cmd.points } as const,
        {
          source: src.source?.id,
          sourceCardId: src.source?.cardId,
          played: src.played ? (true as const) : undefined,
        },
      );
      return settle(state, [...src.with(prevented), impulseBack()]);
    }

    case 'AdditionalStrike': {
      const { s, c, minion } = combatTurn();
      if (c.step !== 'damage') reject('not-now', 'Additional strikes are taken in the damage step');
      if (c.ending) reject('not-now', 'The combat is ending');
      if (c.additional?.includes(minion))
        reject('no-change', 'You already took an additional strike');
      const src = combatSource(cmd.source, s);
      const claimed: EventBody = withOptional(
        { type: 'AdditionalStrikeClaimed', minion } as const,
        {
          source: src.source?.id,
          sourceCardId: src.source?.cardId,
          played: src.played ? (true as const) : undefined,
        },
      );
      return settle(state, [...src.with(claimed), impulseBack()]);
    }

    case 'Press': {
      const { s, c, minion } = combatTurn();
      if (c.step !== 'press') reject('not-now', 'Presses come in the press step');
      if (cmd.mode !== 'continue' && cmd.mode !== 'end') reject('invalid', `No press ${cmd.mode}`);
      // A minion can't press twice in a row.
      if (c.presses?.at(-1)?.minion === minion) {
        reject('not-now', 'You pressed last: the other side answers first');
      }
      const src = combatSource(cmd.source, s);
      const pressed: EventBody = withOptional(
        { type: 'Pressed', minion, mode: cmd.mode } as const,
        {
          source: src.source?.id,
          sourceCardId: src.source?.cardId,
          played: src.played ? (true as const) : undefined,
        },
      );
      return settle(state, [...src.with(pressed), impulseBack()]);
    }

    case 'PassUntil': {
      const s = mySeat ?? reject('not-seated', 'Only players pass');
      const c = state.action?.combat;
      if (state.window?.kind !== 'combat' || !c) reject('not-now', 'There is no combat step open');
      const minion =
        combatantOf(state, s) ?? reject('forbidden', 'You have no minion in this combat');
      if (cmd.until !== 'strikes' && cmd.until !== 'end') reject('invalid', `Pass until what?`);
      if (
        cmd.until === 'strikes' &&
        COMBAT_STEPS.indexOf(c.step) >= COMBAT_STEPS.indexOf('strikes')
      ) {
        reject('no-change', 'The strikes have come already');
      }
      const bodies: EventBody[] = [{ type: 'PassingUntil', seat: s, until: cmd.until }];
      const struck = c.strikes.some((x) => x.minion === minion);
      if (impulseHolder(state) === s && (c.step !== 'strikes' || struck)) {
        bodies.push({ type: 'Passed', seat: s });
      }
      return settle(state, bodies);
    }

    case 'UseCard': {
      const s = mySeat ?? reject('not-seated', 'Only players use cards');
      const c = card(cmd.card);
      if (!faceUpInPlay(c, s)) reject('invalid', 'Use one of your face-up cards in play');
      if (state.window && impulseHolder(state) !== s) {
        reject('not-now', 'Wait for the impulse to use a card');
      }
      const note = cmd.note?.trim();
      if (note && note.length > MAX_NOTE) reject('invalid', 'The note is too long');
      const bodies: EventBody[] = [
        withOptional({ type: 'CardUsed', card: c.id } as const, {
          cardId: c.cardId,
          note: note || undefined,
        }),
      ];
      if (state.window) bodies.push(impulseBack());
      return settle(state, bodies);
    }

    case 'CastVotes': {
      const s = holdingImpulse();
      const a = state.action;
      const r = a?.referendum;
      if (state.window?.kind !== 'polling' || !a || !r) {
        reject(
          'not-now',
          state.window?.kind === 'referendum'
            ? 'Votes come after the cards played before votes: pass first'
            : 'There is no referendum to vote in',
        );
      }
      if (!VOTE_SIDES.includes(cmd.side)) reject('invalid', `Vote for or against, not ${cmd.side}`);
      if (r.abstaining?.includes(s)) reject('forbidden', 'You abstained from this referendum');
      const votes = cmd.votes;
      if (votes !== undefined && (!Number.isInteger(votes) || votes < 1 || votes > 30)) {
        reject('invalid', `Invalid number of votes: ${votes}`);
      }
      const ballots = cmd.ballots;
      if (ballots !== undefined && (!Number.isInteger(ballots) || ballots < 1 || ballots > 9)) {
        reject('invalid', `Invalid number of ballots: ${ballots}`);
      }
      if (ballots !== undefined && cmd.source !== 'minion') {
        reject('invalid', 'Only a minion casts ballots');
      }
      const hunt = r.kind === 'blood-hunt';
      const note = cmd.note?.trim();
      if (note && note.length > MAX_NOTE) reject('invalid', 'The note is too long');
      const mine = r.votes.filter((v) => v.seat === s);
      const base = { seat: s, side: cmd.side };
      const cast = (c: Cast): EventBody => ({ type: 'VotesCast', cast: c });
      const bodies: EventBody[] = [];
      switch (cmd.source) {
        case 'minion': {
          const m = readyMinion(cmd.minion ?? reject('invalid', 'Which minion votes?'), s);
          if (r.cancelled?.includes(m.id)) {
            reject('forbidden', 'That minion abstains: its votes are cancelled');
          }
          const prior = r.votes.find((v) => v.minion === m.id);
          if (prior) {
            // A cast stands; votes gained later join it on the same side (rules-qa 5.1).
            if (prior.side !== cmd.side) {
              reject('forbidden', `That minion voted ${prior.side}: a cast can't be changed`);
            }
            if (votes === undefined && ballots === undefined) {
              reject('invalid', 'Say how many more votes it casts');
            }
          }
          const title = m.cardId ? ctx.catalog.get(m.cardId)?.title : undefined;
          const printed = prior ? 0 : titleVotes(title);
          const printedBallots = prior ? 0 : titleBallots(title);
          const n = votes ?? printed;
          const b = ballots ?? printedBallots;
          if (n + b < 1) {
            reject(
              'invalid',
              'That minion has no votes from a title: say how many a card gives it',
            );
          }
          const claimed =
            !!prior ||
            (votes !== undefined && votes !== printed) ||
            (ballots !== undefined && ballots !== printedBallots);
          bodies.push(
            cast(
              withOptional(
                { ...base, source: 'minion' as const, votes: n, minion: m.id },
                {
                  ballots: b || undefined,
                  cardId: m.cardId,
                  claimed: claimed ? (true as const) : undefined,
                  note: note || undefined,
                },
              ),
            ),
          );
          break;
        }
        case 'edge':
          if (!seat(s).hasEdge) reject('invalid', 'You do not have the Edge');
          if (votes !== undefined && votes !== 1) reject('invalid', 'The Edge is worth 1 vote');
          // Burned for the vote (rulebook, "The Edge").
          bodies.push(cast({ ...base, source: 'edge', votes: 1 }), { type: 'EdgeSet' });
          break;
        case 'card':
          if (hunt) reject('invalid', 'A blood hunt has no calling card');
          if (s !== a.seat || a.card === undefined) {
            reject('invalid', "Only the caller has the calling card's vote");
          }
          if (votes !== undefined && votes !== 1) reject('invalid', 'The card is worth 1 vote');
          if (mine.some((v) => v.source === 'card')) {
            reject('no-change', "You already cast the calling card's vote");
          }
          bodies.push(
            cast(
              withOptional(
                { ...base, source: 'card' as const, votes: 1, card: a.card },
                { cardId: a.cardId },
              ),
            ),
          );
          break;
        case 'burned': {
          const c = card(cmd.card ?? reject('invalid', 'Which political action card?'));
          if (c.zone !== zoneId(s, 'hand')) {
            reject('invalid', 'Burn a political action card from your hand');
          }
          if (a.card === c.id) reject('invalid', 'That card is calling the referendum');
          const types = (c.cardId && ctx.catalog.get(c.cardId)?.types) || [];
          if (!types.includes('Political Action')) {
            reject('invalid', 'Only a political action card can be burned for a vote');
          }
          // One political action card vote each; the caller's is the calling card (rules-qa 46.2).
          if (!hunt && s === a.seat && a.card !== undefined) {
            reject('forbidden', 'The calling card is already your political action card vote');
          }
          if (mine.some((v) => v.source === 'burned')) {
            reject('forbidden', 'You already burned a political action card for a vote');
          }
          if (votes !== undefined && votes !== 1) reject('invalid', 'The card is worth 1 vote');
          const [play, ...rest] = played(c, zoneId(s, 'ashHeap'), true);
          // Its own line says it's burned for the vote.
          const shown = {
            ...(play as Extract<EventBody, { type: 'CardMoved' }>),
            source: true as const,
          };
          bodies.push(
            shown,
            cast(
              withOptional(
                { ...base, source: 'burned' as const, votes: 1, card: c.id },
                { cardId: c.cardId },
              ),
            ),
            ...rest,
          );
          break;
        }
        case 'other': {
          const n = votes ?? reject('invalid', 'How many votes?');
          const src = combatSource(cmd.card, s);
          bodies.push(
            ...src.with(
              cast(
                withOptional(
                  { ...base, source: 'other' as const, votes: n },
                  {
                    card: src.source?.id,
                    cardId: src.source?.cardId,
                    note: note || undefined,
                  },
                ),
              ),
            ),
          );
          break;
        }
        default:
          reject(
            'invalid',
            `Unknown source of votes: ${String((cmd as { source: unknown }).source)}`,
          );
      }
      // A commitment: everyone gets another chance to answer it before the tally (rules-qa 5.3).
      bodies.push(impulseBack());
      return settle(state, bodies);
    }

    case 'Abstain': {
      const s = mySeat ?? reject('not-seated', 'Only players vote');
      const w = state.window;
      const r = state.action?.referendum;
      if (!r || (w?.kind !== 'referendum' && w?.kind !== 'polling')) {
        reject('not-now', 'There is no referendum to abstain from');
      }
      if (!w.order.includes(s)) reject('forbidden', 'You are not part of this referendum');
      if (r.abstaining?.includes(s)) reject('no-change', 'You already abstain');
      return settle(state, [{ type: 'Abstained', seat: s }]);
    }

    case 'CancelVotes': {
      const s = holdingImpulse();
      const r = state.action?.referendum;
      if (state.window?.kind !== 'polling' || !r) {
        reject('not-now', 'Votes are cancelled in a referendum’s polling');
      }
      const m = card(cmd.minion);
      if (!IN_PLAY_ZONES.has(parseZoneId(m.zone).name) || m.attachedTo !== undefined) {
        reject('invalid', 'Choose a minion in play');
      }
      if (r.cancelled?.includes(m.id)) reject('no-change', 'That minion already abstains');
      const src = combatSource(cmd.source, s);
      const cancelled: EventBody = withOptional({ type: 'VotesCancelled', minion: m.id } as const, {
        source: src.source?.id,
        sourceCardId: src.source?.cardId,
        played: src.played ? (true as const) : undefined,
      });
      return settle(state, [...src.with(cancelled), impulseBack()]);
    }

    case 'CallBloodHunt': {
      const a = actingAction();
      if (a.stage !== 'resolution') {
        reject('not-now', 'A blood hunt is called as the action resolves (after the diablerie)');
      }
      const on = card(cmd.minion ?? a.minion);
      if (!IN_PLAY_ZONES.has(parseZoneId(on.zone).name)) {
        reject('invalid', 'The diablerist must be in play');
      }
      // Not an action: no cards played before votes; polling from the acting Methuselah.
      const order = windowOrder(seatRefs(state), a.seat, { directedAt: a.seat });
      return settle(state, [
        withOptional({ type: 'BloodHuntCalled', on: on.id } as const, { cardId: on.cardId }),
        {
          type: 'WindowOpened',
          window: { kind: 'polling', phase: 'minion', order, cursor: 0, passes: 0 },
        },
      ]);
    }

    case 'EndReferendum': {
      const a = actingAction();
      if (!a.referendum) reject('not-now', 'There is no referendum to end');
      const note = cmd.note?.trim();
      if (note && note.length > MAX_NOTE) reject('invalid', 'The note is too long');
      const t = tally(a.referendum);
      return [
        ...(state.window ? [{ type: 'WindowClosed' } as const] : []),
        ...referendumEnd(
          state,
          ids,
          a,
          withOptional(
            {
              type: 'ReferendumResolved',
              passed: !!cmd.passed,
              for: t.for,
              against: t.against,
              reason: 'settled',
            } as const,
            { note: note || undefined },
          ),
        ),
      ];
    }

    case 'CancelAction': {
      actingAction();
      return [
        ...(state.window ? [{ type: 'WindowClosed' } as const] : []),
        { type: 'ActionEnded', outcome: 'cancelled' },
      ];
    }

    case 'ReplacePlayer': {
      if (state.settings.tournament)
        reject('forbidden', 'Players cannot be replaced in tournament games');
      liveSeat(cmd.seat);
      if (!cmd.user) reject('invalid', 'Missing user');
      if (state.seats.some((s) => s.occupant === cmd.user))
        reject('invalid', 'That user is already seated');
      return [{ type: 'PlayerReplaced', seat: cmd.seat, user: cmd.user }];
    }
    case 'SetPresence': {
      const s = liveSeat(cmd.seat);
      if (!!s.present === cmd.present) {
        reject('no-change', cmd.present ? 'Already present' : 'Already away');
      }
      return [{ type: cmd.present ? 'PlayerPresent' : 'PlayerAbsent', seat: s.id }];
    }
    case 'Pause': {
      if (state.settings.timeLimitMs === undefined) {
        reject('invalid', 'Only games with a table timer can be paused');
      }
      if (by.kind !== 'seat' && by.kind !== 'judge') reject('forbidden', 'Only players and judges');
      if (state.pause) reject('no-change', 'The game is already paused');
      if (!Number.isInteger(cmd.minutes) || cmd.minutes < 1 || cmd.minutes > MAX_PAUSE_MINUTES) {
        reject('invalid', `Pause for 1 to ${MAX_PAUSE_MINUTES} minutes`);
      }
      if (by.kind === 'seat') {
        const left = pauseMinutesLeft(state, by.seat);
        if (cmd.minutes > left) {
          reject(
            'not-now',
            left
              ? `You have ${left} min of pause left this game`
              : 'Your pause time for this game is used up; call a judge if you need more',
          );
        }
      }
      const now = ms(ctx.now);
      if (Number.isNaN(now)) reject('invalid', 'No clock');
      return [
        withOptional(
          { type: 'Paused', until: instantFromMs(now + cmd.minutes * MINUTE_MS) } as const,
          { seat: mySeat },
        ),
      ];
    }
    case 'Resume': {
      const p = state.pause ?? reject('no-change', 'The game is not paused');
      if (by.kind !== 'judge' && (mySeat === undefined || p.seat !== mySeat)) {
        reject('forbidden', 'Only whoever paused the game, or a judge, can resume it early');
      }
      return [{ type: 'Resumed' }];
    }
    case 'EndPause': {
      const p = state.pause ?? reject('no-change', 'The game is not paused');
      if (!(ms(ctx.now) >= ms(p.until))) reject('not-now', 'The pause is not over yet');
      return [{ type: 'Resumed' }];
    }
    case 'CheckDeadline': {
      const d = deadlines(state).find((x) => x.seat === cmd.seat);
      const now = ms(ctx.now);
      if (d && !d.expired && now >= ms(d.dueAt)) {
        // Expiry never decides (DQ6): a judge does, and the player can still act until then.
        return [
          { type: 'DeadlineExpired', seat: d.seat, kind: d.kind },
          { type: 'JudgeCalled', call: { reason: 'deadline', seat: d.seat } },
        ];
      }
      if (d && !d.reminded && !d.expired && now >= ms(d.remindAt)) {
        return [{ type: 'DeadlineReminded', seat: d.seat }];
      }
      return reject('no-change', 'Nothing is due');
    }
    case 'CheckTimeLimit': {
      const limit = timeLimit(state);
      if (limit === undefined || state.clock?.limitReachedAt) reject('no-change', 'No time limit');
      if (clockElapsed(state, ctx.now) < limit) reject('no-change', 'Time is not up yet');
      return [
        { type: 'TimeLimitReached' },
        { type: 'JudgeCalled', call: { reason: 'time-limit' } },
      ];
    }
    case 'CallJudge': {
      const s = mySeat ?? reject('not-seated', 'Only players call judges');
      if (!(PLAYER_CALL_REASONS as readonly string[]).includes(cmd.reason)) {
        reject('invalid', `Unknown reason ${cmd.reason}`);
      }
      if (state.judgeCalls?.some((c) => c.by === s)) {
        reject('no-change', 'You already have a judge call open');
      }
      if (cmd.seat !== undefined) seat(cmd.seat);
      if (
        cmd.ref !== undefined &&
        !(Number.isInteger(cmd.ref) && cmd.ref >= 1 && cmd.ref <= state.seq)
      ) {
        reject('invalid', 'No such event');
      }
      const note = cmd.note?.trim();
      if (note && note.length > MAX_CALL_NOTE) reject('invalid', 'The note is too long');
      return [
        {
          type: 'JudgeCalled',
          call: withOptional(
            { reason: cmd.reason, by: s },
            { seat: cmd.seat, ref: cmd.ref, note: note || undefined },
          ),
        },
      ];
    }
    case 'ClaimJudgeCall': {
      const c = openCall(cmd.id);
      if (by.kind !== 'judge') return reject('forbidden', 'Only judges');
      if (c.claimedBy === by.user) reject('no-change', 'You have this call already');
      if (c.claimedBy !== undefined) reject('forbidden', 'Another judge has this call');
      return [{ type: 'JudgeCallClaimed', id: c.id, judge: by.user }];
    }
    case 'EndGame': {
      const note = cmd.note?.trim();
      if (note && note.length > MAX_CALL_NOTE) reject('invalid', 'The note is too long');
      return [gameEnded(state, 'admin', note || undefined)];
    }
    case 'Withdraw': {
      const s = mySeat ?? reject('not-seated', 'Only players withdraw');
      if (seat(s).withdrawing) reject('no-change', 'You are already withdrawing');
      if (!canWithdraw(state, s)) {
        reject(
          'not-now',
          `Withdraw in your unlock phase, once your library is empty and you have under ${FULL_HAND} cards in hand`,
        );
      }
      return [{ type: 'WithdrawalAnnounced', seat: s }];
    }
    case 'ProposeEnd': {
      const s = mySeat ?? reject('not-seated', 'Only players can propose ending the game');
      if (state.settings.tournament) {
        reject('forbidden', 'Tournament games end at the time limit, or when an admin ends them');
      }
      if (state.endProposal) reject('no-change', 'Ending the game has already been proposed');
      return [{ type: 'EndProposed', seat: s }];
    }
    case 'AgreeEnd': {
      const s = mySeat ?? reject('not-seated', 'Only players can agree to end the game');
      const p = state.endProposal ?? reject('not-now', 'Nobody has proposed ending the game');
      if (p.agreed.includes(s)) reject('no-change', 'You have already agreed');
      return [{ type: 'EndAgreed', seat: s }];
    }
    case 'DeclineEnd': {
      const s = mySeat ?? reject('not-seated', 'Only players can decline');
      if (!state.endProposal) reject('not-now', 'Nobody has proposed ending the game');
      return [{ type: 'EndDeclined', seat: s }];
    }
    case 'ResolveJudgeCall': {
      const c = openCall(cmd.id);
      if (by.kind !== 'judge') return reject('forbidden', 'Only judges');
      if (c.claimedBy !== undefined && c.claimedBy !== by.user) {
        reject('forbidden', 'Another judge has this call');
      }
      const note = cmd.note?.trim();
      if (note && note.length > MAX_CALL_NOTE) reject('invalid', 'The note is too long');
      const claim: EventBody[] =
        c.claimedBy === undefined ? [{ type: 'JudgeCallClaimed', id: c.id, judge: by.user }] : [];
      const resolved: EventBody = withOptional(
        { type: 'JudgeCallResolved', id: c.id, ruling: cmd.ruling } as const,
        { note: note || undefined },
      );
      const r = cmd.ruling;
      switch (r.kind) {
        case 'answered':
        case 'escalate':
          return [...claim, resolved];
        case 'extend-deadline': {
          liveSeat(r.seat);
          if (!Number.isInteger(r.hours) || r.hours < 1 || r.hours > 168) {
            reject('invalid', 'Extend by 1 to 168 hours');
          }
          if (!deadlines(state).some((d) => d.seat === r.seat)) {
            reject('not-now', 'That player has no deadline right now');
          }
          return [
            ...claim,
            resolved,
            { type: 'DeadlineExtended', seat: r.seat, ms: r.hours * HOUR_MS },
          ];
        }
        case 'extend-time': {
          if (state.settings.timeLimitMs === undefined)
            reject('invalid', 'This game has no table timer');
          if (!Number.isInteger(r.minutes) || r.minutes < 1 || r.minutes > 120) {
            reject('invalid', 'Add 1 to 120 minutes');
          }
          return [...claim, resolved, { type: 'TimeExtended', ms: r.minutes * MINUTE_MS }];
        }
        case 'pass-for': {
          liveSeat(r.seat);
          if (impulseHolder(state) !== r.seat)
            reject('not-now', 'That player does not hold the impulse');
          // In the strike step, a combatant who hasn't chosen one yet doesn't strike.
          const c = state.action?.combat;
          const minion = combatantOf(state, r.seat);
          const unstruck =
            state.window?.kind === 'combat' &&
            c?.step === 'strikes' &&
            minion !== undefined &&
            !c.strikes.some((x) => x.minion === minion);
          const pass = bodiesFor(
            state,
            unstruck ? { type: 'Strike', kind: 'none' } : { type: 'Pass' },
            ctx,
            { kind: 'seat', seat: r.seat },
            ids,
          );
          return [...claim, resolved, ...pass];
        }
        case 'disqualify': {
          if (!state.settings.tournament) {
            reject(
              'invalid',
              'Disqualification is for tournament games; escalate to an admin instead',
            );
          }
          liveSeat(r.seat);
          // withOusts takes the seat out, without a reward.
          return [...claim, resolved];
        }
      }
      return reject('invalid', 'Unknown ruling');
    }
  }
}

/**
 * A `deadline` call settles itself once that decision is no longer overdue: the player came back
 * to the table, or the game moved on to a new decision (or that seat is out). Players' calls stay
 * open until a judge rules, even about a seat that is out: the dispute may be how it got there.
 */
function settleCalls(
  state: GameState,
  bodies: EventBody[],
  now: string,
  by: ActorRef,
): EventBody[] {
  if (state.status !== 'active') return bodies;
  const after = applyBodies(state, bodies, now, by);
  const settled: EventBody[] = [];
  for (const c of after.judgeCalls ?? []) {
    if (c.reason !== 'deadline' || c.seat === undefined) continue;
    if (deadlines(after).some((d) => d.seat === c.seat && d.expired)) continue;
    settled.push({ type: 'JudgeCallResolved', id: c.id, ruling: { kind: 'answered' }, auto: true });
  }
  return settled.length ? [...bodies, ...settled] : bodies;
}

function applyBodies(from: GameState, bodies: EventBody[], now: string, by: ActorRef): GameState {
  return bodies.reduce(
    (s, body) => evolve(s, { ...body, seq: s.seq + 1, at: now, by } as GameEvent),
    from,
  );
}

/** Run the open window forward: automatic passes, then whatever closing it leads to. */
/** What closing a window may need: fresh instance IDs, and the card data (for combat damage). */
interface Settling {
  ids: () => InstanceId;
  catalog: CardCatalog;
}

function settleWindow(
  from: GameState,
  bodies: EventBody[],
  now: string,
  by: ActorRef,
  sx: Settling,
): EventBody[] {
  const out = [...bodies];
  let s = applyBodies(from, bodies, now, by);
  for (let guard = 0; guard < 100 && s.window; guard++) {
    const w = s.window;
    let next: EventBody[];
    if (w.passes >= w.order.length) next = closeWindow(s, sx, now, by);
    else {
      const holder = w.order[w.cursor];
      if (holder === undefined || !passesAutomatically(s, holder)) break;
      next = [{ type: 'Passed', seat: holder, auto: true }];
    }
    out.push(...next);
    s = applyBodies(s, next, now, by);
  }
  return out;
}

/**
 * Nullify pending withdrawals (GAME-09, `withdrawal.ts`): pool or blood lost or spent, or a minion
 * entering combat, in this command's events, whoever's doing it was.
 */
function withWithdrawals(
  state: GameState,
  bodies: EventBody[],
  now: string,
  by: ActorRef,
): EventBody[] {
  if (state.status !== 'active') return bodies;
  let s = state;
  const broken = new Map<SeatId, WithdrawalBreak>();
  for (const body of bodies) {
    for (const [seat, reason] of withdrawalBreaks(s, body)) {
      if (!broken.has(seat)) broken.set(seat, reason);
    }
    s = applyBodies(s, [body], now, by);
  }
  const breaks = [...broken]
    .filter(([seat]) => s.seats.find((x) => x.id === seat)?.withdrawing)
    .map(([seat, reason]): EventBody => ({ type: 'WithdrawalBroken', seat, reason }));
  return breaks.length ? [...bodies, ...breaks] : bodies;
}

/**
 * End the game when its time has come (GAME-08/09, docs/m6-plan.md M6.1): one Methuselah left or
 * none, the end of the action or phase under way when time ran out (Q2), or everyone still in a
 * casual game agreeing (Q3). Admins end games with `EndGame`.
 */
function withGameEnd(
  state: GameState,
  bodies: EventBody[],
  now: string,
  by: ActorRef,
): EventBody[] {
  if (state.status !== 'active' || bodies.some((b) => b.type === 'GameEnded')) return bodies;
  const after = applyBodies(state, bodies, now, by);
  if (after.status !== 'active') return bodies;
  const live = after.seats.filter((s) => !s.ousted && !s.withdrawn);
  if (live.length <= 1) {
    return [...bodies, gameEnded(after, live.length ? 'last-standing' : 'no-survivors')];
  }
  // Only once time was up before this command: the check that finds it up ends nothing.
  const ends = after.clock?.endsWith === 'action' ? 'ActionEnded' : 'PhaseAdvanced';
  if (state.clock?.limitReachedAt && after.clock?.limitReachedAt) {
    if (bodies.some((b) => b.type === ends)) return [...bodies, gameEnded(after, 'time-limit')];
  }
  const agreed = after.endProposal?.agreed;
  if (agreed && live.every((s) => agreed.includes(s.id))) {
    return [...bodies, gameEnded(after, 'agreement')];
  }
  return bodies;
}

/**
 * The end of the game and its score (zero-vtes rules-qa 6.9): the last Methuselah standing gains a
 * VP; otherwise, unless nobody is left, everyone still in it gains half a VP, as at the time limit
 * (Tournament Rules 3.7.2). The winner has the most VP alone, ousted or not; a game win also needs
 * at least 2 VP.
 */
function gameEnded(state: GameState, reason: GameEndReason, note?: string): EventBody {
  const live = state.seats.filter((s) => !s.ousted && !s.withdrawn);
  const each = reason === 'last-standing' ? 1 : reason === 'no-survivors' ? 0 : 0.5;
  const awards = each ? live.map((s) => ({ seat: s.id, vp: each })) : [];
  const final = state.seats.map((s) => ({
    seat: s.id,
    vp: s.vp + (awards.find((a) => a.seat === s.id)?.vp ?? 0),
  }));
  const top = Math.max(...final.map((f) => f.vp));
  const leaders = final.filter((f) => f.vp === top);
  const winner = leaders.length === 1 && top > 0 ? leaders[0]?.seat : undefined;
  return withOptional({ type: 'GameEnded', reason, awards } as const, {
    winner,
    gameWin: winner !== undefined && top >= 2 ? winner : undefined,
    note,
  });
}

/** Pool and VP for ousting your prey (GAME-08). */
export const OUST_REWARD = { vp: 1, pool: 6 } as const;

/**
 * Oust every live seat the command left at 0 pool or less (GAME-08, GAME-21, DQ9). The command's
 * own effect has resolved by now. For each ousted seat:
 * - the cards it controls in play are removed from the game, and the cards on those are burned;
 *   cards it owns that others control stay in play (`oustedCards`);
 * - its predator (read from the seating before the oust) gains 1 VP and 6 pool, but no pool if the
 *   predator is ousted by the same effect;
 * - it leaves any open window, and an action it is acting in, targeted by or fighting in ends;
 * - if it was its turn, the turn ends and play passes on from its seat.
 */
function withOusts(
  state: GameState,
  bodies: EventBody[],
  now: string,
  by: ActorRef,
  sx: Settling,
  /** A seat a judge disqualified: out like an oust, but nobody is rewarded. */
  disqualify?: SeatId,
): EventBody[] {
  if (state.status !== 'active') return bodies;
  const after = applyBodies(state, bodies, now, by);
  const live = seatRefs(after);
  const out = after.seats
    .filter((x) => !x.ousted && !x.withdrawn && (x.pool <= 0 || x.id === disqualify))
    .map((x) => x.id);
  if (out.length === 0) return bodies;
  const ousting = new Set(out);
  const next: EventBody[] = [];
  next.push(...oustedCards(after, ousting));
  const a = after.action;
  const blockerSeat = a?.blocker ? after.cards[a.blocker]?.controller : undefined;
  const inAction = [a?.seat, a?.target, blockerSeat, ...combatSeats(after)];
  if (a && inAction.some((x) => x !== undefined && ousting.has(x))) {
    // The action (and any combat in it) ends at once: its actor, target or blocker is gone.
    if (after.window) next.push({ type: 'WindowClosed' });
    next.push({ type: 'ActionEnded', outcome: 'ousted' });
  } else if (a?.blockAttempt && ousting.has(a.blockAttempt.seat)) {
    next.push({ type: 'BlockWithdrawn', seat: a.blockAttempt.seat });
  }
  for (const id of out) {
    if (id === disqualify) {
      next.push({ type: 'Ousted', seat: id, disqualified: true });
      continue;
    }
    const pred = predator(live, id);
    const reward = pred === undefined ? undefined : { seat: pred, vp: OUST_REWARD.vp };
    next.push(
      withOptional({ type: 'Ousted', seat: id } as const, {
        predator: reward && {
          ...reward,
          pool: ousting.has(reward.seat) ? 0 : OUST_REWARD.pool,
        },
      }),
    );
  }
  const s = applyBodies(after, next, now, by);
  const turn = s.turn;
  // With one Methuselah left, or none, the game is over (withGameEnd): no turn passes.
  const left = s.seats.filter((x) => !x.ousted && !x.withdrawn).length;
  if (turn && ousting.has(turn.seat) && left >= 2) {
    const endTurn: EventBody[] = [
      ...(s.window ? [{ type: 'WindowClosed' } as const] : []),
      ...(s.action ? [{ type: 'ActionEnded', outcome: 'ousted' } as const] : []),
    ];
    next.push(...endTurn, ...nextTurn(applyBodies(s, endTurn, now, by), now, by));
  }
  return [...bodies, ...settleWindow(after, next, now, by, sx)];
}

/**
 * What happens to the cards in play when Methuselahs are ousted (VTES rulebook, "Ending the game"
 * and "Card ownership"; zero-vtes rules-qa 7.5):
 * - every card an ousted Methuselah controls is removed from the game, wherever it is: their
 *   minions and locations, and master cards they put on other players' minions;
 * - cards on a removed card are burned, to their owners' ash heaps;
 * - cards they own that other Methuselahs control stay in play.
 */
function oustedCards(state: GameState, ousting: ReadonlySet<SeatId>): EventBody[] {
  const inPlay = Object.values(state.cards).filter((c) =>
    IN_PLAY_ZONES.has(parseZoneId(c.zone).name),
  );
  const removed = new Set(inPlay.filter((c) => ousting.has(c.controller)).map((c) => c.id));
  // Anything on a removed card goes with it: burned, even if it would be removed itself.
  const onRemoved = (c: CardInstance): boolean => {
    for (let h = c.attachedTo; h !== undefined; h = state.cards[h]?.attachedTo) {
      if (removed.has(h)) return true;
    }
    return false;
  };
  const move = (c: CardInstance, to: ZoneId, seat: SeatId): EventBody =>
    withOptional(
      {
        type: 'CardMoved',
        card: c.id,
        from: c.zone,
        to,
        position: 'bottom',
        faceDown: false,
        ousted: seat,
      } as const,
      { cardId: c.cardId },
    );
  const burned = inPlay.filter(onRemoved);
  const gone = inPlay.filter((c) => removed.has(c.id) && !onRemoved(c));
  // Whose oust it was: the removed card's controller, or the controller of what it was on.
  const cause = (c: CardInstance): SeatId => {
    let h: CardInstance | undefined = c;
    while (h && !removed.has(h.id)) h = h.attachedTo ? state.cards[h.attachedTo] : undefined;
    return (h ?? c).controller;
  };
  return [
    ...burned.map((c) => move(c, zoneId(c.owner, 'ashHeap'), cause(c))),
    ...gone.map((c) => move(c, zoneId(c.owner, 'removed'), c.controller)),
  ];
}

/** The events that end a fully passed window. */
function closeWindow(state: GameState, sx: Settling, now: string, by: ActorRef): EventBody[] {
  const closed: EventBody = { type: 'WindowClosed' };
  if (state.window?.kind === 'phase') return [closed, ...advancePhase(state)];
  const a = state.action;
  if (state.window?.kind === 'combat' && a?.combat)
    return combatStepClosed(state, a.combat, sx, now, by);
  if (state.window?.kind === 'referendum' && a) {
    // The polling proper, from the caller round the table (rules-qa 64.12).
    const order = windowOrder(seatRefs(state), a.seat, { directedAt: a.seat });
    return [
      closed,
      {
        type: 'WindowOpened',
        window: { kind: 'polling', phase: state.window.phase, order, cursor: 0, passes: 0 },
      },
    ];
  }
  if (state.window?.kind === 'polling' && a?.referendum) {
    const t = tally(a.referendum);
    // A tie fails (rulebook, "The Referendum").
    return [
      closed,
      ...referendumEnd(state, sx.ids, a, {
        type: 'ReferendumResolved',
        passed: t.for > t.against,
        for: t.for,
        against: t.against,
      }),
    ];
  }
  const attempt = a?.blockAttempt;
  if (!a || !attempt) return [closed, { type: 'ActionResolving' }];
  const blocker = state.cards[attempt.minion];
  return [
    closed,
    { type: 'ActionBlocked', blocker: attempt.minion },
    ...(blocker && !blocker.locked
      ? [{ type: 'CardLocked', card: blocker.id, locked: true } as const]
      : []),
    ...combatOpening(state, 'block', a.minion, attempt.minion),
  ];
}

/**
 * What follows a referendum's result. A political action ends successful, passed or not, and its
 * card is burned (rules-qa 5.8). A blood hunt that passes burns the diablerist with the cards on
 * it (rulebook, "The Blood Hunt"); the action it was called in goes back to resolving.
 */
function referendumEnd(
  state: GameState,
  ids: () => InstanceId,
  a: NonNullable<GameState['action']>,
  resolved: Extract<EventBody, { type: 'ReferendumResolved' }>,
): EventBody[] {
  const r = a.referendum;
  if (r?.kind !== 'blood-hunt') {
    return [
      resolved,
      ...finishedActionCard(state, ids, a, 'success'),
      { type: 'ActionEnded', outcome: 'success' },
    ];
  }
  const on = r.on === undefined ? undefined : state.cards[r.on];
  if (!resolved.passed || !on || !IN_PLAY_ZONES.has(parseZoneId(on.zone).name)) return [resolved];
  const burn = (c: CardInstance): EventBody =>
    withOptional(
      {
        type: 'CardMoved',
        card: c.id,
        from: c.zone,
        to: zoneId(c.owner, 'ashHeap'),
        position: 'bottom',
        faceDown: false,
        hunted: true,
      } as const,
      { cardId: c.cardId },
    );
  const borne = Object.values(state.cards).filter((c) => c.attachedTo === on.id);
  return [resolved, ...borne.map(burn), burn(on)];
}

/**
 * Combat starts (docs/flow.md, "Combat"): round 1, close range, before range is determined; each
 * step a window between the two combatants' Methuselahs, the acting minion's first.
 */
function combatOpening(
  state: GameState,
  cause: CombatState['cause'],
  acting: InstanceId,
  opposing: InstanceId,
): EventBody[] {
  const order = [acting, opposing]
    .map((id) => state.cards[id]?.controller)
    .filter((s, i, all): s is SeatId => s !== undefined && all.indexOf(s) === i);
  return [
    {
      type: 'CombatStarted',
      combat: {
        cause,
        acting,
        opposing,
        round: 1,
        step: COMBAT_STEPS[0],
        range: 'close',
        strikes: [],
      },
    },
    {
      type: 'WindowOpened',
      window: { kind: 'combat', phase: state.turn?.phase ?? 'minion', order, cursor: 0, passes: 0 },
    },
  ];
}

/**
 * Both combatants passed a step (docs/flow.md, "Combat"): what comes next. After the strikes, the
 * damage they're about to do (or straight to the end of the round if combat ends was struck);
 * after the damage, applied, any later strikes, additional strikes, or the presses; after the
 * presses, the end of the round, and then another round or the end of the combat.
 */
function combatStepClosed(
  state: GameState,
  c: CombatState,
  sx: Settling,
  now: string,
  by: ActorRef,
): EventBody[] {
  const to = (
    step: CombatState['step'],
    extra: Partial<Extract<EventBody, { type: 'CombatStepped' }>> = {},
  ): EventBody => ({ type: 'CombatStepped', step, round: c.round, ...extra });
  const pending = (p: ReturnType<typeof pendingFrom>): EventBody =>
    withOptional({ type: 'DamagePending', pending: p.pending } as const, {
      later: p.later ? (true as const) : undefined,
    });
  switch (c.step) {
    case 'strikes':
      if (combatEndsStruck(c)) return [to('end-of-round', { ending: true })];
      return [to('damage'), pending(pendingFrom(c))];
    case 'damage': {
      const applied = damageApplied(state, c, sx.catalog);
      const after = applyBodies(state, applied, now, by);
      const fighting = [c.acting, c.opposing].every((m) => isReady(after, m));
      if (!fighting) return [...applied, to('end-of-round', { ending: true })];
      if (c.later) {
        const rest = pendingFrom(c, 'normal');
        if (Object.keys(rest.pending).length) return [...applied, to('damage'), pending(rest)];
      }
      const extra = [...new Set(c.additional ?? [])];
      if (extra.length) return [...applied, to('strikes', { exchange: extra })];
      return [...applied, to(c.ending ? 'end-of-round' : 'press')];
    }
    case 'press': {
      const presses = c.presses ?? [];
      const n = (mode: 'continue' | 'end') => presses.filter((p) => p.mode === mode).length;
      return [to('end-of-round', n('continue') > n('end') ? { continues: true } : {})];
    }
    case 'end-of-round':
      if (c.continues && !c.ending) {
        return [{ type: 'CombatStepped', step: COMBAT_STEPS[0], round: c.round + 1 }];
      }
      return combatEnd(state, sx.ids);
    default: {
      const next = COMBAT_STEPS[COMBAT_STEPS.indexOf(c.step) + 1] ?? 'end-of-round';
      return [to(next)];
    }
  }
}

/** A minion still fighting: in its controller's ready region. */
function isReady(state: GameState, id: InstanceId): boolean {
  const m = state.cards[id];
  return !!m && m.zone === zoneId(m.controller, 'ready');
}

/**
 * The damage step's damage, applied (C5): blood stolen, damage mended with blood or life lost,
 * and wounded vampires to torpor; burned minions to the ash heap with the cards on them.
 * Stolen blood moves first, before anyone mends, so the thief can mend with it; what's over
 * its capacity drains off (rulebook, "Steal Blood"). An ally loses life to a theft, and burns
 * at 0 like a damaged one.
 */
function damageApplied(state: GameState, c: CombatState, catalog: CardCatalog): EventBody[] {
  const out: EventBody[] = [];
  const pending = Object.entries(c.pending ?? {}).filter(
    (e): e is [InstanceId, PendingDamage] => !!e[1] && isReady(state, e[0]),
  );
  // Cards as the thefts leave them, which the damage then reads.
  const after: Record<InstanceId, CardInstance> = {};
  const now = (id: InstanceId) => after[id] ?? (state.cards[id] as CardInstance);
  const counted = (x: CardInstance) => (isVampire(x, catalog) ? 'blood' : 'life');
  for (const [id, p] of pending) {
    if (!p.stolen || !isReady(state, p.by)) continue;
    const victim = now(id);
    const thief = now(p.by);
    const taken = counted(victim);
    const gained = counted(thief);
    const left = victim.counters[taken] ?? 0;
    const amount = Math.min(p.stolen, left);
    if (amount === 0) continue;
    const cap = gained === 'blood' ? catalog.get(thief.cardId ?? '')?.capacity : undefined;
    const has = thief.counters[gained] ?? 0;
    const drained = cap === undefined ? 0 : Math.max(0, Math.min(amount, has + amount - cap));
    out.push(
      withOptional(
        { type: 'BloodStolen', from: id, to: thief.id, amount, taken, gained } as const,
        { drained: drained || undefined },
      ),
    );
    after[id] = {
      ...victim,
      counters: { ...victim.counters, [taken]: left - amount },
    };
    after[thief.id] = {
      ...thief,
      counters: { ...thief.counters, [gained]: has + amount - drained },
    };
  }
  for (const [id, p] of pending) {
    const hit = now(id);
    // An ally whose last life was stolen burns, hurt or not.
    const drained = counted(hit) === 'life' && (hit.counters.life ?? 0) <= 0;
    if (p.normal + p.aggravated === 0 && !drained) continue;
    const t = damageTaken(hit, p, catalog);
    out.push(
      withOptional(
        {
          type: 'DamageResolved',
          minion: id,
          damage: t.damage,
          aggravated: t.aggravated,
          blood: t.blood,
          outcome: t.outcome,
        } as const,
        { life: t.life },
      ),
    );
    if (t.outcome === 'burned') {
      // The cards on it go to their owners' ash heaps with it.
      for (const x of Object.values(state.cards)) {
        if (x.attachedTo !== id) continue;
        out.push({
          type: 'CardMoved',
          card: x.id,
          from: x.zone,
          to: zoneId(x.owner, 'ashHeap'),
          position: 'bottom',
          faceDown: false,
          combat: true,
          ...(x.cardId ? { cardId: x.cardId } : {}),
        });
      }
      out.push({
        type: 'CardMoved',
        card: id,
        from: hit.zone,
        to: zoneId(hit.owner, 'ashHeap'),
        position: 'bottom',
        faceDown: false,
        combat: true,
        ...(hit.cardId ? { cardId: hit.cardId } : {}),
      });
      continue;
    }
    if (t.blood > 0)
      out.push({
        type: 'CounterAdjusted',
        card: id,
        counter: 'blood',
        delta: -t.blood,
        combat: true,
      });
    if (t.life)
      out.push({
        type: 'CounterAdjusted',
        card: id,
        counter: 'life',
        delta: -t.life,
        combat: true,
      });
    if (t.outcome === 'torpor') {
      out.push({
        type: 'CardMoved',
        card: id,
        from: hit.zone,
        to: zoneId(hit.controller, 'torpor'),
        position: 'bottom',
        faceDown: false,
        combat: true,
        ...(hit.cardId ? { cardId: hit.cardId } : {}),
      });
    }
  }
  return out;
}

/** The combat is over, and with it the action: blocked, or done for an action that entered it. */
function combatEnd(state: GameState, ids: () => InstanceId): EventBody[] {
  const a = state.action;
  if (!a) return [];
  const outcome = a.combat?.cause === 'action' ? 'success' : 'blocked';
  return [
    ...(state.window ? [{ type: 'WindowClosed' } as const] : []),
    ...finishedActionCard(state, ids, a, outcome),
    { type: 'ActionEnded', outcome },
  ];
}

/** A card leaving the hand face up, replaced from the library. */
function playedFromHand(
  state: GameState,
  ids: () => InstanceId,
  c: CardInstance,
  to: ZoneId,
  replace: boolean,
  controller?: SeatId,
): EventBody[] {
  const owner = parseZoneId(c.zone).seat;
  const bodies: EventBody[] = [
    withOptional(
      {
        type: 'CardMoved',
        card: c.id,
        from: c.zone,
        to,
        position: 'bottom',
        faceDown: false,
        played: true,
      } as const,
      { cardId: c.cardId, controller },
    ),
  ];
  const top = zoneCards(state, zoneId(owner, 'library'))[0];
  if (replace && top !== undefined) {
    bodies.push({
      type: 'CardsDrawn',
      seat: owner,
      from: 'library',
      cards: [withOptional({ id: top, newId: ids() }, { cardId: state.cards[top]?.cardId })],
    });
  }
  return bodies;
}

/** Where the action card goes when the action ends: into play on success, else the ash heap. */
function finishedActionCard(
  state: GameState,
  ids: () => InstanceId,
  a: NonNullable<GameState['action']>,
  outcome: 'success' | 'failure' | 'blocked',
): EventBody[] {
  const c = a.card === undefined ? undefined : state.cards[a.card];
  if (!c || c.zone !== zoneId(a.seat, 'hand')) return [];
  const minion = state.cards[a.minion];
  const intoPlay = outcome === 'success' && ['equip', 'recruit', 'employ'].includes(a.kind);
  if (!intoPlay) return playedFromHand(state, ids, c, zoneId(a.seat, 'ashHeap'), true);
  if (a.kind === 'equip' && minion && IN_PLAY_ZONES.has(parseZoneId(minion.zone).name)) {
    const [move, ...rest] = playedFromHand(state, ids, c, minion.zone, true);
    return [move as EventBody, { type: 'CardAttached', card: c.id, to: minion.id }, ...rest];
  }
  return playedFromHand(state, ids, c, zoneId(a.seat, 'ready'), true);
}

/** The next phase, or the next turn, which starts by unlocking the new Methuselah's cards. */
function advancePhase(state: GameState): EventBody[] {
  const turn = state.turn;
  if (!turn) return [];
  const next = PHASES[PHASES.indexOf(turn.phase) + 1];
  if (next) return [{ type: 'PhaseAdvanced', turn: { ...turn, phase: next } }];
  return nextTurn(state);
}

/**
 * The next Methuselah's turn, which starts by unlocking their cards. Walks from the current seat's
 * physical position, so it works when that seat was just ousted (GAME-21). A Methuselah whose
 * withdrawal still holds leaves the game as their turn would start, and the turn goes on to the
 * next (zero-vtes rules-qa 95.4); with one Methuselah left, the game is over instead (withGameEnd).
 */
function nextTurn(state: GameState, now = '', by: ActorRef = { kind: 'system' }): EventBody[] {
  const out: EventBody[] = [];
  let s = state;
  for (let guard = 0; guard < s.seats.length; guard++) {
    const turn = s.turn;
    if (!turn) return out;
    const seatId = nextTurnSeat(seatRefs(s), turn.seat, s.turnDirection) ?? turn.seat;
    const seat = s.seats.find((x) => x.id === seatId);
    if (seat?.withdrawing && !seat.ousted && !seat.withdrawn) {
      const leave: EventBody[] = [
        ...oustedCards(s, new Set([seatId])),
        { type: 'Withdrew', seat: seatId, vp: WITHDRAWAL_VP },
      ];
      out.push(...leave);
      s = applyBodies(s, leave, now, by);
      if (s.seats.filter((x) => !x.ousted && !x.withdrawn).length < 2) return out;
      continue;
    }
    const unlocks: EventBody[] = [];
    for (const z of ['ready', 'torpor'] as const) {
      for (const id of zoneCards(s, zoneId(seatId, z))) {
        if (s.cards[id]?.locked) unlocks.push({ type: 'CardLocked', card: id, locked: false });
      }
    }
    return [
      ...out,
      { type: 'PhaseAdvanced', turn: { number: turn.number + 1, seat: seatId, phase: 'unlock' } },
      ...unlocks,
    ];
  }
  return out;
}

/** Every Methuselah starts with 4 crypt cards in the uncontrolled region and 7 in hand. */
export const OPENING_DRAW = {
  crypt: { count: 4, to: 'uncontrolled' },
  library: { count: 7, to: 'hand' },
} as const;

function startGame(
  cmd: Extract<Command, { type: 'StartGame' }>,
  catalog: CardCatalog,
  rng: Rng,
  ids: () => InstanceId,
): EventBody {
  const n = cmd.seats.length;
  if (cmd.format === 'duel' ? n !== 2 : n < 3 || n > 5) {
    reject(
      'invalid',
      cmd.format === 'duel' ? 'Duels need exactly 2 players' : 'Games need 3 to 5 players',
    );
  }
  if (new Set(cmd.seats.map((s) => s.id)).size !== n) reject('invalid', 'Duplicate seat');
  if (new Set(cmd.seats.map((s) => s.user)).size !== n) reject('invalid', 'Duplicate player');
  const settings: GameSettings = { tournament: false, startingPool: 30, ...cmd.settings };
  // Tournament rounds always run against the clock: at least two hours (Tournament Rules 3.1.1).
  if (settings.tournament) settings.timeLimitMs ??= MIN_TOURNAMENT_TIME_LIMIT_MS;
  for (const [key, min] of [
    ['timeLimitMs', settings.tournament ? MIN_TOURNAMENT_TIME_LIMIT_MS : 10 * MINUTE_MS],
    ['deadlineMs', 10 * MINUTE_MS],
  ] as const) {
    const v = settings[key];
    if (v !== undefined && (!Number.isInteger(v) || v < min)) {
      reject('invalid', `${key} must be at least ${min / MINUTE_MS} minutes`);
    }
  }
  const cards: Extract<EventBody, { type: 'GameStarted' }>['cards'] = [];
  for (const s of cmd.seats) {
    for (const kind of ['crypt', 'library'] as const) {
      for (const cardId of s[kind]) {
        const info = catalog.get(cardId) ?? reject('unknown-card', `Unknown card ${cardId}`);
        if (info.kind !== kind) reject('invalid', `${info.name} is not a ${kind} card`);
      }
      // The opening draw is part of setup, not a play, so it isn't logged as draws.
      const dealt = OPENING_DRAW[kind];
      shuffled(s[kind], rng).forEach((cardId, i) => {
        const zone = zoneId(s.id, i < dealt.count ? dealt.to : kind);
        cards.push({ id: ids(), cardId, owner: s.id, zone });
      });
    }
  }
  return {
    type: 'GameStarted',
    gameId: cmd.gameId,
    format: cmd.format,
    settings,
    seats: cmd.seats.map((s) => ({ id: s.id, user: s.user })),
    cards,
  };
}

/** Fresh instance IDs, unique within the game and within this command. */
function idSource(state: GameState, rng: Rng): () => InstanceId {
  const issued = new Set<InstanceId>();
  return () => {
    const id = newInstanceId(rng, (x) => x in state.cards || issued.has(x));
    issued.add(id);
    return id;
  };
}

/** Add optional properties only when defined (exactOptionalPropertyTypes). */
function withOptional<T extends object, O extends object>(
  base: T,
  optional: O,
): T & { [K in keyof O]?: Exclude<O[K], undefined> } {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(optional)) if (v !== undefined) out[k] = v;
  return out as T & { [K in keyof O]?: Exclude<O[K], undefined> };
}
