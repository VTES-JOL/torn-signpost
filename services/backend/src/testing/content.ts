/** The engine's invented test cards as content records (real card data is never committed). */
import type { CardRecord } from '@torn-signpost/cards';
import testCards from '@torn-signpost/engine/test-catalog.json' with { type: 'json' };
import { staticContent } from '../content/catalog.ts';

export const testRecords: CardRecord[] = testCards.cards.map((c) => ({
  id: c.id,
  name: c.name,
  printedName: c.name,
  kind: c.kind as 'crypt' | 'library',
  types: [c.kind === 'crypt' ? 'Vampire' : 'Master'],
  ...(c.kind === 'crypt'
    ? { group: '2', capacity: 'capacity' in c ? (c.capacity as number) : 5 }
    : {}),
  text: '',
  sets: ['Test Set'],
  legalFrom: '2000-01-01',
  v5: true,
  aliases: [],
  artists: [],
}));

export const testContent = staticContent(testRecords);

/** A legal deck from the test cards. */
export const testDeck = {
  crypt: [{ id: 't-vera', count: 12 }],
  library: [
    { id: 't-feed', count: 40 },
    { id: 't-ward', count: 20 },
  ],
};
