import { CARD_GRANTS } from './grants.ts';
import type { CardId } from './model.ts';

/**
 * A default flow rule a card lifts (docs/flow.md, "Overrides"). Data only: the engine doesn't
 * script card effects, it only uses these to check an override a player claims.
 * - `bleed-any`: bleed a Methuselah other than your prey.
 * - `block-any`: attempt to block ignoring the prey, predator or target restrictions.
 */
export const GRANTS = ['bleed-any', 'block-any'] as const;
export type Grant = (typeof GRANTS)[number];

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
  /** A crypt card's printed title (`Prince`, `2 votes`…), for its votes in referendums. */
  title?: string;
  /** Flow rules the card lifts. Filled from `CARD_GRANTS` by `createCatalog` when missing. */
  grants?: readonly Grant[];
}

export interface CardCatalog {
  get(id: CardId): CardInfo | undefined;
  all(): readonly CardInfo[];
}

export function createCatalog(cards: readonly CardInfo[]): CardCatalog {
  const byId = new Map(
    cards.map((c) => {
      const grants = c.grants ?? CARD_GRANTS[c.id];
      return [c.id, grants && !c.grants ? { ...c, grants } : c];
    }),
  );
  const all = [...byId.values()];
  return { get: (id) => byId.get(id), all: () => all };
}

/** Case-, accent- and punctuation-insensitive form used for name matching. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * The votes a ready vampire's title is worth (rulebook, "Titled Vampires" and "Other Vampire
 * Sects"); a priscus's ballots go to the prisci block instead. Unknown titles are worth none.
 */
export function titleVotes(title: string | undefined): number {
  if (!title) return 0;
  const n = /^(\d+) votes?$/i.exec(title.trim());
  if (n) return Number(n[1]);
  return TITLE_VOTES[title.trim().toLowerCase()] ?? 0;
}

const TITLE_VOTES: Record<string, number> = {
  primogen: 1,
  bishop: 1,
  prince: 2,
  baron: 2,
  archbishop: 2,
  magaji: 2,
  kholo: 2,
  justicar: 3,
  cardinal: 3,
  'inner circle': 4,
  regent: 4,
};
