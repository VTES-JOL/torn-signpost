/**
 * Human-readable game log lines (GAME-12), rendered from a projected event and the viewer's view
 * before it, so each viewer reads only what they're allowed to see. Bookkeeping events with
 * nothing to tell (automatic passes, for one) describe as an empty string.
 */
import type { CardCatalog } from './catalog.ts';
import type { BloodHolder } from './commands.ts';
import type { GameEvent } from './events.ts';
import type { WaitKind } from './flow.ts';
import type {
  ActionKind,
  ActorRef,
  CardId,
  CombatState,
  CombatStep,
  GameState,
  InstanceId,
  JudgeCallReason,
  Override,
  Ruling,
  Strike,
  ZoneId,
  ZoneName,
} from './model.ts';
import type { SeatId } from './seating.ts';
import { parseZoneId } from './zones.ts';

const WAIT_NAMES: Record<WaitKind, string> = {
  phase: 'their turn',
  impulse: 'the impulse',
  block: 'a block',
  resolve: 'resolving an action',
  combat: 'combat',
};

const CALL_REASONS: Record<JudgeCallReason, string> = {
  'slow-play': 'slow play',
  rules: 'rules question',
  dispute: 'dispute',
  deadline: 'deadline',
  'time-limit': 'time limit',
  other: 'other',
};

export function rulingText(r: Ruling, seatName: (s: SeatId) => string): string {
  switch (r.kind) {
    case 'answered':
      return 'answered at the table';
    case 'extend-deadline':
      return `${seatName(r.seat)} gets ${r.hours} more hours`;
    case 'pass-for':
      return `${seatName(r.seat)} passes`;
    case 'extend-time':
      return `${r.minutes} minutes added to the timer`;
    case 'disqualify':
      return `${seatName(r.seat)} is disqualified`;
    case 'escalate':
      return 'referred to a server admin';
  }
}

const ZONE_LABELS: Record<ZoneName, string> = {
  crypt: 'crypt',
  library: 'library',
  hand: 'hand',
  uncontrolled: 'uncontrolled region',
  ready: 'ready region',
  torpor: 'torpor',
  ashHeap: 'ash heap',
  removed: 'removed from game',
  research: 'research area',
};

const SHORT_ZONE_LABELS: Record<ZoneName, string> = {
  ...ZONE_LABELS,
  uncontrolled: 'uncontrolled',
  ready: 'ready',
  research: 'research',
};

export interface DescribeOptions {
  catalog: CardCatalog;
  /** Display name for a seat; defaults to the seat ID. */
  seatName?: (seat: SeatId) => string;
}

/** What each combat step is called. */
export const COMBAT_STEP_LABELS: Record<CombatStep, string> = {
  'before-range': 'Before range',
  range: 'Range',
  'before-strikes': 'Before strikes',
  strikes: 'Strikes',
  damage: 'Damage',
  press: 'Press',
  'end-of-round': 'End of round',
};

/** "Round 1 · Range" for a combat step (docs/flow.md, "Combat"). */
export function combatStepLabel(c: Pick<CombatState, 'round' | 'step'>): string {
  return `Round ${c.round} · ${COMBAT_STEP_LABELS[c.step]}`;
}

/** "2R damage", "a hand strike for 1", "dodge"… (without the striker). */
export function strikeText(s: Strike): string {
  const n = s.amount ?? 1;
  const what = {
    hand: `a hand strike for ${n}`,
    damage: `${n}${s.ranged ? 'R' : ''}${s.aggravated ? ' aggravated' : ''} damage`,
    dodge: 'dodge',
    'combat-ends': 'combat ends',
    'steal-blood': `steal ${n} blood`,
    other: s.note ?? 'a strike',
    none: 'no strike',
  }[s.kind];
  const ranged = s.ranged && s.kind !== 'damage' ? ', ranged' : '';
  const first = s.first ? ', first strike' : '';
  const note = s.note && s.kind !== 'other' ? ` (“${s.note}”)` : '';
  return `${what}${ranged}${first}${note}`;
}

/**
 * The log line for an event. Everything said during a combat step is prefixed with the round and
 * step, so the table can see what was played when (docs/m6-plan.md M6.4, C3).
 */
export function describeEvent(ev: GameEvent, before: GameState, opts: DescribeOptions): string {
  const line = describeBare(ev, before, opts);
  const c = before.action?.combat;
  if (!line || !c || before.window?.kind !== 'combat') return line;
  if (ev.type === 'ActionEnded' || ev.type === 'CombatStepped') return line;
  return `${combatStepLabel(c)}: ${line}`;
}

function describeBare(ev: GameEvent, before: GameState, opts: DescribeOptions): string {
  const seatName = opts.seatName ?? ((s: SeatId) => s);
  const who = actorName(ev.by, seatName);
  const cardName = (id: InstanceId, cardId?: CardId) => {
    const known = cardId ?? before.cards[id]?.cardId;
    if (!known) return 'a card';
    // Known to the viewer but missing from the card data (e.g. a deck from another catalog).
    return opts.catalog.get(known)?.name ?? `an unknown card (${known})`;
  };
  const zone = (z: ZoneId) => {
    const { seat, name } = parseZoneId(z);
    const owner = ev.by.kind === 'seat' && ev.by.seat === seat ? 'their' : `${seatName(seat)}'s`;
    return name === 'removed' ? ZONE_LABELS[name] : `${owner} ${ZONE_LABELS[name]}`;
  };
  // Short, for moves: "from uncontrolled to ready" in the mover's own zones, else "Bob's torpor".
  const place = (z: ZoneId) => {
    const { seat, name } = parseZoneId(z);
    if (name === 'removed') return ZONE_LABELS[name];
    const short = SHORT_ZONE_LABELS[name];
    return ev.by.kind === 'seat' && ev.by.seat === seat ? short : `${seatName(seat)}'s ${short}`;
  };
  const holder = (h: BloodHolder) =>
    'pool' in h ? `${seatName(h.pool)}'s pool` : cardName(h.card);
  const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  /** ", ignoring the prey restriction (<card>, unverified)" for a claimed card effect. */
  const overrideNote = (o: Override | undefined) => {
    if (!o) return '';
    const rule = o.grant === 'bleed-any' ? 'the prey restriction' : 'the blocking restrictions';
    const source = o.source === undefined ? 'no card named' : cardName(o.source, o.sourceCardId);
    return `, ignoring ${rule} (${source}${o.verified ? '' : ', unverified'})`;
  };

  switch (ev.type) {
    case 'GameStarted':
      return `Game started with ${ev.seats.map((s) => seatName(s.id)).join(', ')}`;
    case 'CardMoved': {
      const name = ev.faceDown ? 'a face-down card' : cardName(ev.card, ev.cardId);
      if (ev.ousted !== undefined) {
        const fate =
          parseZoneId(ev.to).name === 'removed' ? 'is removed from the game' : 'is burned';
        return `${capitalize(name)} ${fate}: ${seatName(ev.ousted)} was ousted`;
      }
      // Played as the source of a combat move, or moved by combat damage: their own lines tell it.
      if (ev.source || ev.combat) return '';
      if (ev.played) {
        const to = parseZoneId(ev.to);
        const into =
          to.name === 'ashHeap'
            ? ''
            : to.name === 'ready' && ev.by.kind === 'seat' && ev.by.seat === to.seat
              ? ' into play'
              : ` into ${place(ev.to)}`;
        const from = parseZoneId(ev.from).seat;
        // In a combat step, the combatant plays it: "Beast plays Immortal Grapple" (M6.4).
        const c = before.action?.combat;
        if (c && before.window?.kind === 'combat' && parseZoneId(ev.from).name === 'hand') {
          const fighter = [c.acting, c.opposing].find((m) => before.cards[m]?.controller === from);
          if (fighter) return `${cardName(fighter)} plays ${name}${into}`;
        }
        // Whoever's hand it left: an action card is finished off by whoever ends the action.
        return `${seatName(from)} played ${name}${into}`;
      }
      const toName = parseZoneId(ev.to).name;
      const where =
        ev.position === 'top' && (toName === 'crypt' || toName === 'library') ? 'top of ' : '';
      return `${who} moved ${name} from ${place(ev.from)} to ${where}${place(ev.to)}`;
    }
    case 'CardsDrawn': {
      const n = ev.cards.length;
      const names = ev.cards.every((c) => c.cardId)
        ? `: ${ev.cards.map((c) => cardName(c.id, c.cardId)).join(', ')}`
        : '';
      return `${seatName(ev.seat)} drew ${n} ${n === 1 ? 'card' : 'cards'} from their ${ev.from}${names}`;
    }
    case 'ZoneShuffled':
      return `${who} shuffled ${zone(ev.zone)}`;
    case 'CardFlipped':
      return ev.faceDown
        ? `${who} turned ${cardName(ev.card, ev.cardId)} face down`
        : `${who} turned ${cardName(ev.card, ev.cardId)} face up`;
    case 'CardLocked':
      return `${who} ${ev.locked ? 'locked' : 'unlocked'} ${cardName(ev.card)}`;
    case 'CardContested':
      return `${who} marked ${cardName(ev.card)} as ${ev.contested ? 'contested' : 'uncontested'}`;
    case 'CounterAdjusted':
      if (ev.combat) return '';
      return `${who}: ${cardName(ev.card)} ${signed(ev.delta)} ${ev.counter}`;
    case 'PoolAdjusted':
      return `${who}: ${seatName(ev.seat)}'s pool ${signed(ev.delta)}`;
    case 'VpAdjusted':
      return `${who}: ${seatName(ev.seat)} ${signed(ev.delta)} VP`;
    case 'BloodStolen': {
      const drained = ev.drained ? `; ${ev.drained} drains off, over capacity` : '';
      return `${cardName(ev.to)} steals ${ev.amount} ${ev.taken} from ${cardName(ev.from)}${drained}`;
    }
    case 'BloodTransferred':
      return `${who} moved ${ev.amount} blood from ${holder(ev.from)} to ${holder(ev.to)}`;
    case 'CardAttached':
      return ev.to
        ? `${who} attached ${cardName(ev.card)} to ${cardName(ev.to)}`
        : `${who} detached ${cardName(ev.card)}`;
    case 'CardRevealed':
      return `${who} revealed ${cardName(ev.card, ev.cardId)}`;
    case 'JudgeRevealed': {
      const z = before.cards[ev.card]?.zone;
      return `${who} looked at a hidden card${z ? ` in ${zone(z)}` : ''}`;
    }
    case 'EdgeSet':
      return ev.seat ? `${seatName(ev.seat)} took the Edge` : 'Nobody has the Edge';
    case 'TurnDirectionSet':
      return `${who} reversed the turn order: play now passes to the ${ev.direction === 'toPrey' ? 'prey' : 'predator'}`;
    case 'PhaseAdvanced':
      return ev.turn.phase === 'unlock'
        ? `Turn ${ev.turn.number}: ${seatName(ev.turn.seat)}'s unlock phase`
        : `${seatName(ev.turn.seat)}'s ${ev.turn.phase} phase`;
    case 'PlayerReplaced':
      return `${who} replaced the player in seat ${seatName(ev.seat)}`;
    case 'Paused': {
      const minutes = Math.round((Date.parse(ev.until) - Date.parse(ev.at)) / 60_000);
      const span = Number.isFinite(minutes)
        ? ` for ${minutes} minute${minutes === 1 ? '' : 's'}`
        : '';
      return `${who} paused the game${span}`;
    }
    case 'Resumed':
      return ev.by.kind === 'system' ? 'The pause is over' : `${who} resumed the game`;
    case 'DeadlineExpired':
      return `${seatName(ev.seat)} ran out of time for a decision (${WAIT_NAMES[ev.kind]}); a judge will step in`;
    case 'TimeLimitReached':
      return 'Time is up: the game ends with the current action, or at the end of this phase';
    case 'GameEnded': {
      const why: Record<typeof ev.reason, string> = {
        'last-standing': `${seatName(ev.awards[0]?.seat ?? '')} is the last Methuselah standing (+1 VP)`,
        'no-survivors': 'Nobody is left standing',
        'time-limit': 'Time is up: everyone still in the game gains ½ VP',
        admin: `${who} ended the game; everyone still in it gains ½ VP`,
        agreement: 'The players agreed to end the game; everyone still in it gains ½ VP',
      };
      const end = ev.winner
        ? `${seatName(ev.winner)} wins${ev.gameWin ? ' (a game win)' : ''}`
        : 'Nobody wins';
      return `Game over. ${why[ev.reason]}${ev.note ? ` (“${ev.note}”)` : ''}. ${end}`;
    }
    case 'WithdrawalAnnounced':
      return `${seatName(ev.seat)} announces a withdrawal: they leave the game at the start of their next turn, if they lose or spend no pool or blood and none of their minions enters combat`;
    case 'WithdrawalBroken': {
      const why = {
        pool: 'they lost or spent pool',
        blood: 'a vampire of theirs lost or spent blood',
        combat: 'a minion of theirs entered combat',
      }[ev.reason];
      return `${seatName(ev.seat)}'s withdrawal no longer holds: ${why}`;
    }
    case 'Withdrew':
      return `${seatName(ev.seat)} withdrew from the game (+½ VP)`;
    case 'EndProposed':
      return `${seatName(ev.seat)} proposes ending the game; everyone still in it must agree`;
    case 'EndAgreed':
      return `${seatName(ev.seat)} agrees to end the game`;
    case 'EndDeclined':
      return `${seatName(ev.seat)} wants to play on`;
    // Bookkeeping with nothing to tell (auto-pass settings and stops are private): no log line.
    case 'AutoPassSet':
    case 'StopsSet':
    // Presence shows on the seats, not in the log (TEMPO-06); reminders go to the player.
    case 'PlayerPresent':
    case 'PlayerAbsent':
    case 'DeadlineReminded':
    case 'ImpulseReset':
    case 'WindowClosed':
      return '';
    case 'WindowOpened':
      return ev.window.kind === 'phase' && before.turn
        ? `End of ${seatName(before.turn.seat)}'s ${ev.window.phase} phase: waiting for the other players`
        : '';
    case 'Held':
      return `${seatName(ev.seat)} asks the table to wait`;
    case 'Passed': {
      if (ev.auto) return '';
      const a = before.action;
      const declines =
        before.window?.kind === 'blocks' &&
        a &&
        !a.blockAttempt &&
        a.eligible.includes(ev.seat) &&
        !a.declined.includes(ev.seat);
      return `${seatName(ev.seat)} ${declines ? 'declined to block' : 'passed'}`;
    }
    case 'ActionDeclared': {
      const a = ev.action;
      const verb = ACTION_VERBS[a.kind];
      const target =
        a.target === undefined
          ? ''
          : a.kind === 'bleed'
            ? ` ${seatName(a.target)}`
            : ` against ${seatName(a.target)}`;
      const card = a.card === undefined ? '' : ` with ${cardName(a.card, a.cardId)}`;
      return `${who}: ${cardName(a.minion)} ${verb}${target}${card}${overrideNote(a.override)}`;
    }
    case 'BlockAttempted':
      return `${seatName(ev.seat)} tries to block with ${cardName(ev.minion)}${overrideNote(ev.override)}`;
    case 'BlockWithdrawn':
      return `${seatName(ev.seat)} withdrew the block`;
    case 'ActionBlocked':
      return `${cardName(ev.blocker)} blocks: combat`;
    case 'ActionResolving':
      return 'The action was not blocked';
    // A block's combat was announced with the block.
    case 'CombatStarted':
      return ev.combat.cause === 'block'
        ? ''
        : `${cardName(ev.combat.acting)} enters combat with ${cardName(ev.combat.opposing)}`;
    case 'CombatStepped': {
      const c = before.action?.combat;
      if (c && ev.round > c.round) return `Round ${ev.round} of combat`;
      if (ev.exchange) {
        return `Additional strikes: ${ev.exchange.map((m) => cardName(m)).join(' and ')}`;
      }
      return '';
    }
    case 'DamagePending': {
      const parts = Object.entries(ev.pending).flatMap(([id, p]) => {
        if (!p) return [];
        const what = [
          ...(p.normal ? [`${p.normal} damage`] : []),
          ...(p.aggravated ? [`${p.aggravated} aggravated damage`] : []),
          ...(p.stolen ? [`${p.stolen} blood stolen`] : []),
        ];
        return what.length ? [`${cardName(id)} is about to take ${what.join(' and ')}`] : [];
      });
      return parts.length ? parts.join('; ') : 'No strike lands';
    }
    case 'DamagePrevented': {
      const m = cardName(ev.minion);
      const src = ev.source === undefined ? undefined : cardName(ev.source, ev.sourceCardId);
      if (src && ev.played) return `${m} plays ${src} to prevent ${ev.points} damage`;
      return `${m} prevents ${ev.points} damage${src ? ` with ${src}` : ''}`;
    }
    case 'DamageResolved': {
      const m = cardName(ev.minion);
      const took = [
        ...(ev.damage ? [`${ev.damage} damage`] : []),
        ...(ev.aggravated ? [`${ev.aggravated} aggravated`] : []),
      ].join(' and ');
      const blood = ev.blood ? ` (${ev.blood} blood)` : '';
      switch (ev.outcome) {
        case 'unhurt':
          return `${m} takes no damage`;
        case 'mended':
          return `${m} takes ${took} and mends it${blood}`;
        case 'hurt':
          return `${m} takes ${took}: −${ev.life ?? 0} life`;
        case 'torpor':
          return `${m} takes ${took}${blood} and goes to torpor`;
        case 'burned':
          return took ? `${m} takes ${took} and is burned` : `${m} has no life left and is burned`;
      }
      return '';
    }
    case 'AdditionalStrikeClaimed': {
      const m = cardName(ev.minion);
      const src = ev.source === undefined ? undefined : cardName(ev.source, ev.sourceCardId);
      if (src && ev.played) return `${m} plays ${src} for an additional strike`;
      return `${m} takes an additional strike${src ? ` with ${src}` : ''}`;
    }
    case 'Pressed': {
      const m = cardName(ev.minion);
      const src = ev.source === undefined ? undefined : cardName(ev.source, ev.sourceCardId);
      const what = ev.mode === 'continue' ? 'press to continue' : 'press to end the combat';
      if (src && ev.played) return `${m} plays ${src} to ${what}`;
      return `${m} ${ev.mode === 'continue' ? 'presses to continue' : 'presses to end the combat'}${src ? ` with ${src}` : ''}`;
    }
    case 'Maneuvered': {
      const m = cardName(ev.minion);
      const src = ev.source === undefined ? undefined : cardName(ev.source, ev.sourceCardId);
      if (src && ev.played) return `${m} plays ${src} to maneuver to ${ev.to}`;
      return `${m} maneuvers to ${ev.to}${src ? ` using ${src}` : ''}`;
    }
    case 'StrikeChosen': {
      const m = cardName(ev.minion);
      const st = ev.strike;
      if (st.kind === 'none') return `${m} doesn't strike`;
      const src = st.source === undefined ? undefined : cardName(st.source, st.sourceCardId);
      if (src && ev.played) return `${m} plays ${src} to strike: ${strikeText(st)}`;
      return `${m} strikes${src ? ` with ${src}` : ''}: ${strikeText(st)}`;
    }
    case 'PassingUntil':
      return `${seatName(ev.seat)} passes until ${ev.until === 'strikes' ? 'the strikes' : 'the end of the round'}`;
    case 'CardUsed': {
      const host = before.cards[ev.card]?.attachedTo;
      const user = host === undefined ? who : cardName(host);
      return `${user} uses ${cardName(ev.card, ev.cardId)}${ev.note ? `: ${ev.note}` : ''}`;
    }
    case 'ActionEnded':
      return {
        success: 'The action succeeded',
        failure: 'The action failed',
        blocked: 'Combat is over; the action was blocked',
        cancelled: `${who} cancelled the action`,
        ousted: 'The action ends: a Methuselah in it was ousted',
      }[ev.outcome];
    case 'JudgeCalled': {
      const c = ev.call;
      const about = c.seat ? ` about ${seatName(c.seat)}` : '';
      const note = c.note ? `: “${c.note}”` : '';
      if (c.reason === 'deadline') {
        return `A judge has been called: ${seatName(c.seat ?? '')} ran out of time`;
      }
      if (c.reason === 'time-limit') return 'A judge has been called: the time limit was reached';
      return `${who} called a judge (${CALL_REASONS[c.reason]})${about}${note}`;
    }
    case 'JudgeCallClaimed':
      return `${who} is handling the judge call`;
    case 'JudgeCallResolved': {
      if (ev.auto) return 'The judge call is settled: the player decided';
      const note = ev.note ? `: “${ev.note}”` : '';
      return `${who} ruled: ${rulingText(ev.ruling, seatName)}${note}`;
    }
    // A ruling's effect: the ruling line just before says it.
    case 'DeadlineExtended':
    case 'TimeExtended':
      return '';
    case 'Ousted': {
      if (ev.disqualified) return `${seatName(ev.seat)} was disqualified`;
      const reward = ev.predator;
      if (!reward) return `${seatName(ev.seat)} was ousted`;
      const gains = [`${reward.vp} VP`, ...(reward.pool ? [`${reward.pool} pool`] : [])];
      return `${seatName(ev.seat)} was ousted; ${seatName(reward.seat)} gains ${gains.join(' and ')}`;
    }
  }
}

const ACTION_VERBS: Record<ActionKind, string> = {
  bleed: 'bleeds',
  hunt: 'hunts',
  political: 'calls a political action',
  equip: 'equips',
  recruit: 'recruits an ally',
  employ: 'employs a retainer',
  other: 'takes an action',
};

function actorName(by: ActorRef, seatName: (s: SeatId) => string): string {
  switch (by.kind) {
    case 'seat':
      return seatName(by.seat);
    case 'judge':
      return 'A judge';
    case 'admin':
      return 'An admin';
    case 'system':
      return 'The system';
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
