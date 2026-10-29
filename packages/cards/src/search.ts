/**
 * Client-side card search (DECK-02, AD-07): the whole catalog is small enough to search in memory,
 * so search is instant and works offline.
 */
import { normalizeName } from '@torn-signpost/engine';
import type { CardRecord } from './model.ts';
import { type Format, isLegal } from './validate.ts';

export interface CardQuery {
  /** Fuzzy match on the name and aliases. */
  name?: string;
  /** Words that must all appear in the card text. */
  text?: string;
  kind?: 'crypt' | 'library';
  /** Any of these types. */
  types?: string[];
  /** Any of these clans. */
  clans?: string[];
  /** All of these disciplines; upper case means superior is required. */
  disciplines?: string[];
  sect?: string;
  capacity?: { min?: number; max?: number };
  /** Any of these groups (`ANY` cards always match). */
  groups?: string[];
  /** Only cards legal in this format, as of `date`. */
  format?: Format;
  date?: string;
  limit?: number;
}

export interface CardIndex {
  cards: readonly CardRecord[];
  byId: ReadonlyMap<string, CardRecord>;
  names: ReadonlyMap<string, string[]>;
  text: ReadonlyMap<string, string>;
}

export function createIndex(cards: readonly CardRecord[]): CardIndex {
  return {
    cards,
    byId: new Map(cards.map((c) => [c.id, c])),
    names: new Map(
      cards.map((c) => [c.id, [c.name, c.printedName, ...c.aliases].map(normalizeName)]),
    ),
    text: new Map(cards.map((c) => [c.id, c.text.toLowerCase()])),
  };
}

/** Name score: exact 100, prefix 80, word prefix 60, substring 40, in-order letters 10; 0 = no match. */
export function nameScore(query: string, name: string, words?: string[]): number {
  const q = normalizeName(query);
  if (!q) return 1;
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (words?.some((w) => normalizeName(w).startsWith(q))) return 60;
  if (name.includes(q)) return 40;
  let i = 0;
  for (const ch of name) if (ch === q[i]) i++;
  return i === q.length && q.length >= 3 ? 10 : 0;
}

export function searchCards(index: CardIndex, query: CardQuery): CardRecord[] {
  const textWords = query.text?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const results: { card: CardRecord; score: number }[] = [];
  for (const card of index.cards) {
    if (query.kind && card.kind !== query.kind) continue;
    if (query.types?.length && !query.types.some((t) => card.types.includes(t))) continue;
    if (query.clans?.length && !query.clans.some((c) => card.clans?.includes(c))) continue;
    if (query.sect && card.sect !== query.sect) continue;
    if (query.disciplines?.length && !query.disciplines.every((d) => hasDiscipline(card, d)))
      continue;
    if (query.capacity) {
      const cap = card.capacity;
      if (cap === undefined) continue;
      if (query.capacity.min !== undefined && cap < query.capacity.min) continue;
      if (query.capacity.max !== undefined && cap > query.capacity.max) continue;
    }
    if (
      query.groups?.length &&
      !(card.group === 'ANY' || query.groups.includes(card.group ?? ''))
    ) {
      continue;
    }
    if (query.format && !isLegal(card, query.format, query.date)) continue;
    const text = index.text.get(card.id) ?? '';
    if (!textWords.every((w) => text.includes(w))) continue;
    let score = 1;
    if (query.name) {
      const names = index.names.get(card.id) ?? [];
      score = Math.max(
        0,
        ...names.map((n) => nameScore(query.name ?? '', n, card.printedName.split(/[\s,]+/))),
      );
      if (score === 0) continue;
    }
    results.push({ card, score });
  }
  results.sort((a, b) => b.score - a.score || a.card.name.localeCompare(b.card.name));
  return results.slice(0, query.limit ?? results.length).map((r) => r.card);
}

/** `aus` matches inferior or superior; `AUS` only superior. Library cards match their requirements. */
function hasDiscipline(card: CardRecord, d: string): boolean {
  const list = card.disciplines ?? [];
  if (card.kind === 'library') return list.some((x) => x.toLowerCase() === d.toLowerCase());
  return d === d.toUpperCase() ? list.includes(d) : list.some((x) => x.toLowerCase() === d);
}
