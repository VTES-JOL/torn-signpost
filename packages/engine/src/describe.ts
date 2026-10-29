/**
 * Human-readable game log lines (GAME-12), rendered from a projected event and the viewer's view
 * before it, so each viewer reads only what they're allowed to see.
 */
import type { CardCatalog } from './catalog.ts';
import type { BloodHolder } from './commands.ts';
import type { GameEvent } from './events.ts';
import type { ActorRef, CardId, GameState, InstanceId, ZoneId, ZoneName } from './model.ts';
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
  }
}

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
