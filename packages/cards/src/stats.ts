/** Deck statistics for the deck builder (DECK-06). */
import type { DeckCards } from './deck.ts';
import type { CardIndex } from './search.ts';

export interface DeckStats {
  crypt: {
    count: number;
    capacity: { min: number; max: number; average: number };
    /** Copies per capacity. */
    curve: Record<number, number>;
    clans: Record<string, number>;
    /** Copies with each discipline at superior and inferior level. */
    disciplines: Record<string, { superior: number; inferior: number }>;
  };
  library: {
    count: number;
    types: Record<string, number>;
    /** Copies requiring each discipline. */
    disciplines: Record<string, number>;
    clans: Record<string, number>;
    poolCost: number;
    bloodCost: number;
  };
}

export function deckStats(deck: DeckCards, index: CardIndex): DeckStats {
  const add = (rec: Record<string, number>, key: string, n: number) => {
    rec[key] = (rec[key] ?? 0) + n;
  };
  const crypt: DeckStats['crypt'] = {
    count: 0,
    capacity: { min: 0, max: 0, average: 0 },
    curve: {},
    clans: {},
    disciplines: {},
  };
  const caps: number[] = [];
  for (const { id, count } of deck.crypt) {
    const card = index.byId.get(id);
    if (!card) continue;
    crypt.count += count;
    if (card.capacity !== undefined) {
      caps.push(...Array<number>(count).fill(card.capacity));
      crypt.curve[card.capacity] = (crypt.curve[card.capacity] ?? 0) + count;
    }
    for (const clan of card.clans ?? []) add(crypt.clans, clan, count);
    for (const d of card.disciplines ?? []) {
      const key = d.toLowerCase();
      const entry = crypt.disciplines[key] ?? { superior: 0, inferior: 0 };
      crypt.disciplines[key] = entry;
      if (d === d.toUpperCase()) entry.superior += count;
      else entry.inferior += count;
    }
  }
  if (caps.length) {
    crypt.capacity = {
      min: Math.min(...caps),
      max: Math.max(...caps),
      average: Math.round((caps.reduce((a, b) => a + b, 0) / caps.length) * 100) / 100,
    };
  }
  const library: DeckStats['library'] = {
    count: 0,
    types: {},
    disciplines: {},
    clans: {},
    poolCost: 0,
    bloodCost: 0,
  };
  for (const { id, count } of deck.library) {
    const card = index.byId.get(id);
    if (!card) continue;
    library.count += count;
    for (const t of card.types) add(library.types, t, count);
    for (const d of card.disciplines ?? []) add(library.disciplines, d.toLowerCase(), count);
    for (const c of card.clans ?? []) add(library.clans, c, count);
    library.poolCost += (Number.parseInt(card.poolCost ?? '', 10) || 0) * count;
    library.bloodCost += (Number.parseInt(card.bloodCost ?? '', 10) || 0) * count;
  }
  return { crypt, library };
}
