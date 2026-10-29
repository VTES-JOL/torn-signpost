/** Deck validation per format (DECK-04). */
import type { DeckCards } from './deck.ts';
import { deckSize } from './deck.ts';
import type { CardRecord } from './model.ts';
import type { CardIndex } from './search.ts';

export type Format = 'standard' | 'v5' | 'duel';

export interface DeckIssue {
  level: 'error' | 'warning';
  code:
    | 'crypt-size'
    | 'library-size'
    | 'grouping'
    | 'banned'
    | 'not-yet-legal'
    | 'not-in-format'
    | 'unknown-card'
    | 'wrong-section';
  message: string;
  cardId?: string;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Standard and Duel: every legal card. V5: only the V5 card pool. Duel uses the Standard deck
 * rules until a separate duel ruleset is agreed.
 */
export function isLegal(card: CardRecord, format: Format, date = today()): boolean {
  if (card.legalFrom > date) return false;
  if (card.bannedFrom && card.bannedFrom <= date) return false;
  return format !== 'v5' || card.v5;
}

export function validateDeck(
  deck: DeckCards,
  index: CardIndex,
  format: Format,
  date = today(),
): DeckIssue[] {
  const issues: DeckIssue[] = [];
  const crypt = deckSize(deck.crypt);
  const library = deckSize(deck.library);
  if (crypt < 12) {
    issues.push({
      level: 'error',
      code: 'crypt-size',
      message: `The crypt needs at least 12 cards (has ${crypt})`,
    });
  }
  if (library < 60 || library > 90) {
    issues.push({
      level: 'error',
      code: 'library-size',
      message: `The library needs 60–90 cards (has ${library})`,
    });
  }
  const groups = new Set<number>();
  for (const section of ['crypt', 'library'] as const) {
    for (const { id } of deck[section]) {
      const card = index.byId.get(id);
      if (!card) {
        issues.push({
          level: 'error',
          code: 'unknown-card',
          message: `Unknown card ${id}`,
          cardId: id,
        });
        continue;
      }
      if (card.kind !== section) {
        issues.push({
          level: 'error',
          code: 'wrong-section',
          message: `${card.name} belongs in the ${card.kind}`,
          cardId: id,
        });
      }
      if (section === 'crypt' && card.group && card.group !== 'ANY') groups.add(Number(card.group));
      if (card.bannedFrom && card.bannedFrom <= date) {
        issues.push({
          level: 'error',
          code: 'banned',
          message: `${card.name} is banned`,
          cardId: id,
        });
      } else if (card.legalFrom > date) {
        issues.push({
          level: 'error',
          code: 'not-yet-legal',
          message: `${card.name} is legal from ${card.legalFrom}`,
          cardId: id,
        });
      } else if (format === 'v5' && !card.v5) {
        issues.push({
          level: 'error',
          code: 'not-in-format',
          message: `${card.name} is not in the V5 card pool`,
          cardId: id,
        });
      }
    }
  }
  if (groups.size > 0 && Math.max(...groups) - Math.min(...groups) > 1) {
    issues.push({
      level: 'error',
      code: 'grouping',
      message: `Crypt groups must be consecutive (has ${[...groups].sort().join(', ')})`,
    });
  }
  return issues;
}
