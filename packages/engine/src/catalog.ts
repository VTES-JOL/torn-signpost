import type { CardId } from './model.ts';

/**
 * Card attributes are injected from the content pack (§5.5), so the engine and this repo carry no
 * World of Darkness text (LEGAL-08).
 */
export interface CardInfo {
  id: CardId;
  name: string;
  kind: 'crypt' | 'library';
  capacity?: number;
  /** Library card types as printed, e.g. `Master`, `Action`, `Reaction`. Used to filter offers. */
  types?: readonly string[];
}

export interface CardCatalog {
  get(id: CardId): CardInfo | undefined;
  all(): readonly CardInfo[];
}

export function createCatalog(cards: readonly CardInfo[]): CardCatalog {
  const byId = new Map(cards.map((c) => [c.id, c]));
  return { get: (id) => byId.get(id), all: () => cards };
}

/** Case-, accent- and punctuation-insensitive form used for name matching. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}
