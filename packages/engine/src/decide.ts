import type { CardCatalog } from './catalog.ts';
import type { BloodHolder, Command } from './commands.ts';
import type { EventBody, GameEvent } from './events.ts';
import { evolve } from './evolve.ts';
import { eligibleBlockers, impulseHolder, passesAutomatically, seatRefs } from './flow.ts';
import type {
  Actor,
  ActorRef,
  CardInstance,
  GameSettings,
  GameState,
  InstanceId,
  Instant,
  ZoneId,
} from './model.ts';
import { ACTION_KINDS, PHASES } from './model.ts';
import { canSee } from './projection.ts';
import { newInstanceId, type Rng, shuffled } from './rng.ts';
import { nextTurnSeat, prey, type SeatId, windowOrder } from './seating.ts';
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
    const bodies = bodiesFor(state, cmd, ctx, by);
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
  if (cmd.type === 'JudgeReveal' && actor.kind !== 'judge') {
    reject('forbidden', 'Only judges can look at hidden cards');
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
  const ownSeatOrJudge = (id: SeatId) => {
    seat(id);
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
  /** The action in progress, which the actor (its Methuselah or a judge) may steer. */
  const actingAction = () => {
    const a = state.action ?? reject('not-now', 'No action in progress');
    if (mySeat !== undefined && mySeat !== a.seat) reject('forbidden', 'It is not your action');
    return a;
  };
  /** A card leaving the hand face up, replaced from the library. */
  const played = (c: CardInstance, to: ZoneId, replace: boolean): EventBody[] => {
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
        { cardId: c.cardId },
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
  const apply = (from: GameState, bodies: EventBody[]) =>
    bodies.reduce(
      (s, body) => evolve(s, { ...body, seq: s.seq + 1, at: ctx.now, by } as GameEvent),
      from,
    );
  /** Run the open window forward: automatic passes, then whatever closing it leads to. */
  const settle = (from: GameState, bodies: EventBody[]): EventBody[] => {
    const out = [...bodies];
    let s = apply(from, bodies);
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
      s = apply(s, next);
    }
    return out;
  };

  switch (cmd.type) {
    case 'StartGame':
      return [startGame(cmd, ctx.catalog, ctx.rng, ids)];

    case 'MoveCard': {
      const c = touchable(cmd.card);
      const { seat: toSeat, name: toName } = parseZoneId(cmd.to);
      seat(toSeat);
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
      const s = seat(cmd.seat);
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
        if ('pool' in h) return seat(h.pool).pool;
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
      const host = touchable(cmd.to);
      if (!IN_PLAY_ZONES.has(parseZoneId(host.zone).name))
        reject('invalid', 'The host is not in play');
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
            { cardId: c.cardId },
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
      if (cmd.seat !== undefined) seat(cmd.seat);
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
      const probe = apply(state, [opened]);
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
      if (cmd.kind === 'bleed') {
        target ??= prey(seatRefs(state), s) ?? reject('invalid', 'There is nobody to bleed');
      }
      let cardId: string | undefined;
      if (cmd.card !== undefined) {
        const c = card(cmd.card);
        if (c.zone !== zoneId(s, 'hand')) reject('invalid', 'The action card must be in your hand');
        cardId = c.cardId;
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
          { target, card: cmd.card, cardId },
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
      if (!a.eligible.includes(s) || a.declined.includes(s)) {
        reject('forbidden', 'You cannot block this action');
      }
      if (a.blockAttempt) reject('not-now', 'A block attempt is already pending');
      const minion = readyMinion(cmd.minion, s);
      return settle(state, [{ type: 'BlockAttempted', seat: s, minion: minion.id }]);
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
      if (cmd.attachTo !== undefined) {
        const host = touchable(cmd.attachTo);
        if (!IN_PLAY_ZONES.has(parseZoneId(host.zone).name))
          reject('invalid', 'The host is not in play');
        to = host.zone;
      }
      const bodies: EventBody[] = [played(c, to, cmd.replace ?? true)].flat();
      if (cmd.attachTo !== undefined)
        bodies.splice(1, 0, { type: 'CardAttached', card: c.id, to: cmd.attachTo });
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
      seat(cmd.seat);
      if (!cmd.user) reject('invalid', 'Missing user');
      if (state.seats.some((s) => s.occupant === cmd.user))
        reject('invalid', 'That user is already seated');
      return [{ type: 'PlayerReplaced', seat: cmd.seat, user: cmd.user }];
    }
  }
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
  const cards: Extract<EventBody, { type: 'GameStarted' }>['cards'] = [];
  for (const s of cmd.seats) {
    for (const kind of ['crypt', 'library'] as const) {
      for (const cardId of s[kind]) {
        const info = catalog.get(cardId) ?? reject('unknown-card', `Unknown card ${cardId}`);
        if (info.kind !== kind) reject('invalid', `${info.name} is not a ${kind} card`);
      }
      for (const cardId of shuffled(s[kind], rng)) {
        cards.push({ id: ids(), cardId, owner: s.id, zone: zoneId(s.id, kind) });
      }
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
