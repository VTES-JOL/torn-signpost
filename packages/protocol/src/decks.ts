/** Deck API (DECK-03/07). Decks are saved as immutable versions; import/export runs client-side. */
import { z } from 'zod';

const CardCount = z.strictObject({
  id: z.string().regex(/^[\w-]{1,16}$/),
  count: z.number().int().min(1).max(90),
});

export const DeckCards = z.strictObject({
  crypt: z.array(CardCount).max(60),
  library: z.array(CardCount).max(150),
});
export type DeckCards = z.infer<typeof DeckCards>;

export const DeckFormat = z.enum(['standard', 'v5', 'duel']);

export const SaveDeckRequest = z.strictObject({
  name: z.string().trim().min(1).max(80),
  format: DeckFormat,
  visibility: z.enum(['private', 'public']),
  notes: z.string().max(5000).exactOptional(),
  cards: DeckCards,
});
export type SaveDeckRequest = z.infer<typeof SaveDeckRequest>;

export interface DeckSummary {
  id: string;
  name: string;
  format: z.infer<typeof DeckFormat>;
  visibility: 'private' | 'public';
  owner: string;
  ownerName: string;
  version: number;
  cryptCount: number;
  libraryCount: number;
  /** Whether the latest version is legal in its format (DECK-04). */
  legal: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DeckDetails extends DeckSummary {
  notes?: string;
  cards: DeckCards;
}

export interface DeckVersion {
  id: string;
  version: number;
  cards: DeckCards;
  createdAt: string;
}
