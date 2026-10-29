/**
 * What a player can do to a card, as menu items (UX-01: every common operation without typing).
 * The server still checks every command (GAME-10); this only decides what to offer.
 */
import {
  type CardInstance,
  HIDDEN_ZONES,
  IN_PLAY_ZONES,
  parseZoneId,
  type ZoneId,
  type ZoneName,
  zoneId,
} from '@torn-signpost/engine';
import type { PlayerCommand } from '@torn-signpost/protocol';

export interface MenuItem {
  label: string;
  command?: PlayerCommand;
  /** Pick another card next (attach). */
  pick?: 'attach';
  danger?: boolean;
}

export function cardActions(
  card: CardInstance,
  seat: string | undefined,
  judge: boolean,
): MenuItem[] {
  const { seat: zoneSeat, name } = parseZoneId(card.zone);
  const mine = zoneSeat === seat || card.controller === seat || card.owner === seat;
  const hiddenElsewhere = HIDDEN_ZONES.has(name) && zoneSeat !== seat;
  if (!seat && !judge) return [];
  if (hiddenElsewhere && !judge) return [];
  const id = card.id;
  const move = (
    label: string,
    to: ZoneId,
    extra: Partial<Extract<PlayerCommand, { type: 'MoveCard' }>> = {},
  ): MenuItem => ({
    label,
    command: { type: 'MoveCard', card: id, to, ...extra },
  });
  const own = (z: ZoneName) => zoneId(card.owner, z);
  const ctl = (z: ZoneName) => zoneId(card.controller, z);
  const counter = (
    counter: 'blood' | 'life' | 'generic',
    delta: number,
    label: string,
  ): MenuItem => ({
    label,
    command: { type: 'AdjustCounter', card: id, counter, delta },
  });
  const items: MenuItem[] = [];

  switch (name) {
    case 'hand':
      items.push(
        move('Play', zoneId(card.owner, 'ready')),
        move('Play face down', zoneId(card.owner, 'ready'), { faceDown: true }),
        { label: 'Play on a minion…', pick: 'attach' },
        move('Discard', own('ashHeap')),
        move('Put on top of library', own('library'), { position: 'top' }),
        move('Put on bottom of library', own('library'), { position: 'bottom' }),
        { label: 'Reveal', command: { type: 'Reveal', card: id } },
      );
      break;
    case 'uncontrolled':
      items.push(
        move('Influence out (to ready)', own('ready')),
        {
          label: 'Transfer 1 blood from pool',
          command: {
            type: 'TransferBlood',
            from: { pool: card.owner },
            to: { card: id },
            amount: 1,
          },
        },
        {
          label: 'Transfer 1 blood back to pool',
          command: {
            type: 'TransferBlood',
            from: { card: id },
            to: { pool: card.owner },
            amount: 1,
          },
        },
        { label: 'Reveal', command: { type: 'Reveal', card: id } },
        move('Return to crypt', own('crypt'), { position: 'bottom' }),
      );
      break;
    case 'library':
    case 'crypt':
      if (judge) items.push({ label: 'Look (judge)', command: { type: 'JudgeReveal', card: id } });
      break;
    default: {
      if (IN_PLAY_ZONES.has(name) || name === 'research') {
        items.push({
          label: card.locked ? 'Unlock' : 'Lock',
          command: { type: 'SetLocked', card: id, locked: !card.locked },
        });
        items.push(counter('blood', 1, '+1 blood'), counter('blood', -1, '−1 blood'));
        if (card.controller === seat) {
          items.push({
            label: 'Transfer 1 blood from pool',
            command: {
              type: 'TransferBlood',
              from: { pool: card.controller },
              to: { card: id },
              amount: 1,
            },
          });
        }
        items.push(
          counter('life', 1, '+1 life'),
          counter('life', -1, '−1 life'),
          counter('generic', 1, '+1 counter'),
          counter('generic', -1, '−1 counter'),
        );
        items.push(
          name === 'torpor'
            ? move('Rescue from torpor', ctl('ready'))
            : move('Send to torpor', ctl('torpor')),
        );
        items.push({ label: 'Attach to…', pick: 'attach' });
        if (card.attachedTo) items.push({ label: 'Detach', command: { type: 'Attach', card: id } });
        items.push({
          label: card.faceDown ? 'Turn face up' : 'Turn face down',
          command: { type: 'Flip', card: id },
        });
        items.push({
          label: card.contested ? 'Mark uncontested' : 'Mark contested',
          command: { type: 'SetContested', card: id, contested: !card.contested },
        });
        if (card.faceDown && card.owner === seat)
          items.push({ label: 'Reveal', command: { type: 'Reveal', card: id } });
        items.push(
          move('Burn (ash heap)', own('ashHeap'), {}),
          move('Return to hand', own('hand')),
        );
        items.push(move('Remove from game', own('removed')));
      } else {
        // Ash heap and removed from game.
        items.push(
          move('Return to hand', own('hand')),
          move('Put into play', own('ready')),
          move('Put on top of library', own('library')),
        );
        if (name !== 'removed') items.push(move('Remove from game', own('removed')));
      }
    }
  }
  if (!mine && !judge) {
    // Other players' public cards: changes notify their owner (GAME-10); keep the common ones.
    return items.filter((i) => i.command?.type !== 'Reveal');
  }
  return items.map((i) => (i.label.startsWith('Burn') ? { ...i, danger: true } : i));
}
