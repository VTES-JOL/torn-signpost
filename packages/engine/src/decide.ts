import type { CardCatalog, Grant } from './catalog.ts';
import {
  clockElapsed,
  deadlines,
  HOUR_MS,
  instantFromMs,
  MAX_PAUSE_MINUTES,
  MIN_TOURNAMENT_TIME_LIMIT_MS,
  MINUTE_MS,
  ms,
  timeLimit,
} from './clock.ts';
import type { BloodHolder, Command } from './commands.ts';
import type { EventBody, GameEvent } from './events.ts';
import { evolve } from './evolve.ts';
import {
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
  GameSettings,
  GameState,
  InstanceId,
  Instant,
  Override,
  StopRule,
  ZoneId,
} from './model.ts';
import { ACTION_KINDS, PHASES, PLAYER_CALL_REASONS, STOP_ACTORS, STOP_TRIGGERS } from './model.ts';
import { canSee } from './projection.ts';
import { newInstanceId, type Rng, shuffled } from './rng.ts';
import { nextTurnSeat, predator, prey, type SeatId, windowOrder } from './seating.ts';
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
 * event's `by`), admins may only replace players, and the system starts games.
 */
export function decide(state: GameState, cmd: Command, ctx: DecideContext): DecideResult {
  try {
    const by = actorRef(state, cmd, ctx.actor);
    const dq =
      cmd.type === 'ResolveJudgeCall' && cmd.ruling.kind === 'disqualify'
        ? cmd.ruling.seat
        : undefined;
    const bodies = settleCalls(
      state,
      withOusts(state, bodiesFor(state, cmd, ctx, by), ctx.now, by, dq),
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
]);

const MAX_CALL_NOTE = 500;

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

function bodiesFor(state: GameState, cmd: Command, ctx: DecideContext, by: ActorRef): EventBody[] {
  const ids = idSource(state, ctx.rng);
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
  /** A card leaving the hand face up, replaced from the library. */
  const played = (
    c: CardInstance,
    to: ZoneId,
    replace: boolean,
    controller?: SeatId,
  ): EventBody[] => {
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
        cards: [withOptional({ id: top, newId: ids() }, { cardId: card(top).cardId })],
      });
    }
    return bodies;
  };
  /** Where the action card goes when the action ends: into play on success, else the ash heap. */
  const finishActionCard = (
    a: NonNullable<GameState['action']>,
    outcome: 'success' | 'failure' | 'blocked',
  ): EventBody[] => {
    const c = a.card === undefined ? undefined : state.cards[a.card];
    if (!c || c.zone !== zoneId(a.seat, 'hand')) return [];
    const minion = state.cards[a.minion];
    const intoPlay = outcome === 'success' && ['equip', 'recruit', 'employ'].includes(a.kind);
    if (!intoPlay) return played(c, zoneId(a.seat, 'ashHeap'), true);
    if (a.kind === 'equip' && minion && IN_PLAY_ZONES.has(parseZoneId(minion.zone).name)) {
      const [move, ...rest] = played(c, minion.zone, true);
      return [move as EventBody, { type: 'CardAttached', card: c.id, to: minion.id }, ...rest];
    }
    return played(c, zoneId(a.seat, 'ready'), true);
  };
  const settle = (from: GameState, bodies: EventBody[]) => settleWindow(from, bodies, ctx.now, by);

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
      if (state.window) bodies.push({ type: 'ImpulseReset' });
      return settle(state, bodies);
    }

    case 'ResolveAction': {
      const a = actingAction();
      if (a.stage !== 'resolution') reject('not-now', 'The action is not ready to resolve');
      const amount = cmd.amount ?? 1;
      if (!Number.isInteger(amount) || amount < 0) reject('invalid', `Invalid amount: ${amount}`);
      const bodies: EventBody[] = [];
      if (cmd.outcome === 'success' && a.kind === 'bleed' && a.target !== undefined) {
        const loss = Math.min(amount, seat(a.target).pool);
        if (loss > 0) bodies.push({ type: 'PoolAdjusted', seat: a.target, delta: -loss });
        if (cmd.edge && !seat(a.seat).hasEdge) bodies.push({ type: 'EdgeSet', seat: a.seat });
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
      if (mySeat !== undefined && mySeat !== a.seat && mySeat !== blockerSeat) {
        reject('forbidden', 'Only the players in combat can end it');
      }
      return [...finishActionCard(a, 'blocked'), { type: 'ActionEnded', outcome: 'blocked' }];
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
          const pass = bodiesFor(state, { type: 'Pass' }, ctx, { kind: 'seat', seat: r.seat });
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
function settleWindow(
  from: GameState,
  bodies: EventBody[],
  now: string,
  by: ActorRef,
): EventBody[] {
  const out = [...bodies];
  let s = applyBodies(from, bodies, now, by);
  for (let guard = 0; guard < 100 && s.window; guard++) {
    const w = s.window;
    let next: EventBody[];
    if (w.passes >= w.order.length) next = closeWindow(s);
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
  const inAction = [a?.seat, a?.target, blockerSeat];
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
  if (turn && ousting.has(turn.seat)) {
    const endTurn: EventBody[] = [
      ...(s.window ? [{ type: 'WindowClosed' } as const] : []),
      ...(s.action ? [{ type: 'ActionEnded', outcome: 'ousted' } as const] : []),
    ];
    next.push(...endTurn, ...nextTurn(applyBodies(s, endTurn, now, by)));
  }
  return [...bodies, ...settleWindow(after, next, now, by)];
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
function closeWindow(state: GameState): EventBody[] {
  const closed: EventBody = { type: 'WindowClosed' };
  if (state.window?.kind === 'phase') return [closed, ...advancePhase(state)];
  const attempt = state.action?.blockAttempt;
  if (!attempt) return [closed, { type: 'ActionResolving' }];
  const blocker = state.cards[attempt.minion];
  return [
    closed,
    { type: 'ActionBlocked', blocker: attempt.minion },
    ...(blocker && !blocker.locked
      ? [{ type: 'CardLocked', card: blocker.id, locked: true } as const]
      : []),
  ];
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
 * physical position, so it works when that seat was just ousted (GAME-21).
 */
function nextTurn(state: GameState): EventBody[] {
  const turn = state.turn;
  if (!turn) return [];
  const seatId = nextTurnSeat(seatRefs(state), turn.seat, state.turnDirection) ?? turn.seat;
  const unlocks: EventBody[] = [];
  for (const z of ['ready', 'torpor'] as const) {
    for (const id of zoneCards(state, zoneId(seatId, z))) {
      if (state.cards[id]?.locked) unlocks.push({ type: 'CardLocked', card: id, locked: false });
    }
  }
  return [
    { type: 'PhaseAdvanced', turn: { number: turn.number + 1, seat: seatId, phase: 'unlock' } },
    ...unlocks,
  ];
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
