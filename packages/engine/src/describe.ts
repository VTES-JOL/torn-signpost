/**
 * Human-readable game log lines (GAME-12), rendered from a projected event and the viewer's view
 * before it, so each viewer reads only what they're allowed to see. Bookkeeping events with
 * nothing to tell (automatic passes, for one) describe as an empty string.
 */
import type { CardCatalog } from './catalog.ts';
import type { BloodHolder } from './commands.ts';
import type { GameEvent } from './events.ts';
import type {
  ActionKind,
  ActorRef,
  CardId,
  GameState,
  InstanceId,
  ZoneId,
  ZoneName,
} from './model.ts';
import type { SeatId } from './seating.ts';
import { parseZoneId } from './zones.ts';

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

export interface DescribeOptions {
  catalog: CardCatalog;
  /** Display name for a seat; defaults to the seat ID. */
  seatName?: (seat: SeatId) => string;
}

export function describeEvent(ev: GameEvent, before: GameState, opts: DescribeOptions): string {
  const seatName = opts.seatName ?? ((s: SeatId) => s);
  const who = actorName(ev.by, seatName);
  const cardName = (id: InstanceId, cardId?: CardId) => {
    const known = cardId ?? before.cards[id]?.cardId;
    return (known && opts.catalog.get(known)?.name) || 'a card';
  };
  const zone = (z: ZoneId) => {
    const { seat, name } = parseZoneId(z);
    const owner = ev.by.kind === 'seat' && ev.by.seat === seat ? 'their' : `${seatName(seat)}'s`;
    return name === 'removed' ? ZONE_LABELS[name] : `${owner} ${ZONE_LABELS[name]}`;
  };
  const holder = (h: BloodHolder) =>
    'pool' in h ? `${seatName(h.pool)}'s pool` : cardName(h.card);
  const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

  switch (ev.type) {
    case 'GameStarted':
      return `Game started with ${ev.seats.map((s) => seatName(s.id)).join(', ')}`;
    case 'CardMoved': {
      const name = ev.faceDown ? 'a face-down card' : cardName(ev.card, ev.cardId);
      if (ev.played) {
        const into = parseZoneId(ev.to).name === 'ashHeap' ? '' : ` into ${zone(ev.to)}`;
        return `${who} played ${name}${into}`;
      }
      const toName = parseZoneId(ev.to).name;
      const where =
        ev.position === 'top' && (toName === 'crypt' || toName === 'library') ? 'top of ' : '';
      return `${who} moved ${name} from ${zone(ev.from)} to ${where}${zone(ev.to)}`;
    }
    case 'CardsDrawn': {
      const n = ev.cards.length;
      const names = ev.cards.every((c) => c.cardId)
        ? `: ${ev.cards.map((c) => cardName(c.id, c.cardId)).join(', ')}`
        : '';
      return `${who} drew ${n} ${n === 1 ? 'card' : 'cards'} from their ${ev.from}${names}`;
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
      return `${who}: ${cardName(ev.card)} ${signed(ev.delta)} ${ev.counter}`;
    case 'PoolAdjusted':
      return `${who}: ${seatName(ev.seat)}'s pool ${signed(ev.delta)}`;
    case 'VpAdjusted':
      return `${who}: ${seatName(ev.seat)} ${signed(ev.delta)} VP`;
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
    // Bookkeeping with nothing to tell (auto-pass settings are private): no log line.
    case 'AutoPassSet':
    case 'ImpulseReset':
    case 'WindowClosed':
      return '';
    case 'WindowOpened':
      return ev.window.kind === 'phase' && before.turn
        ? `End of ${seatName(before.turn.seat)}'s ${ev.window.phase} phase: waiting for the other players`
        : '';
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
      return `${who}: ${cardName(a.minion)} ${verb}${target}${card}`;
    }
    case 'BlockAttempted':
      return `${seatName(ev.seat)} tries to block with ${cardName(ev.minion)}`;
    case 'BlockWithdrawn':
      return `${seatName(ev.seat)} withdrew the block`;
    case 'ActionBlocked':
      return `${cardName(ev.blocker)} blocks: combat`;
    case 'ActionResolving':
      return 'The action was not blocked';
    case 'ActionEnded':
      return {
        success: 'The action succeeded',
        failure: 'The action failed',
        blocked: 'Combat is over; the action was blocked',
        cancelled: `${who} cancelled the action`,
      }[ev.outcome];
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
