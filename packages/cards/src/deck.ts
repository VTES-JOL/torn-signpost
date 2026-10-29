/** Deck lists, import and export (DECK-05). */
import { normalizeName } from '@torn-signpost/engine';
import type { CardRecord } from './model.ts';
import type { CardIndex } from './search.ts';

export interface CardCount {
  id: string;
  count: number;
}

export interface DeckCards {
  crypt: CardCount[];
  library: CardCount[];
}

export interface ImportIssue {
  line?: number;
  text: string;
  message: string;
}

export interface ImportResult {
  deck: DeckCards;
  name?: string;
  issues: ImportIssue[];
}

export const emptyDeck = (): DeckCards => ({ crypt: [], library: [] });

export function deckSize(cards: CardCount[]): number {
  return cards.reduce((n, c) => n + c.count, 0);
}

/** Whether two lists hold the same cards, in any order. */
export function sameCards(a: DeckCards, b: DeckCards): boolean {
  const key = (d: DeckCards) =>
    [...d.crypt, ...d.library]
      .map((c) => `${c.id}:${c.count}`)
      .sort()
      .join(',');
  return key(a) === key(b);
}

/** Add (or with a negative count, remove) copies of a card; keeps the list sorted by name. */
export function addCard(
  deck: DeckCards,
  card: CardRecord,
  count = 1,
  index?: CardIndex,
): DeckCards {
  const section = deck[card.kind];
  const existing = section.find((c) => c.id === card.id);
  const next = existing
    ? section.map((c) => (c.id === card.id ? { ...c, count: c.count + count } : c))
    : count > 0
      ? [...section, { id: card.id, count }]
      : section;
  const cleaned = next.filter((c) => c.count > 0);
  if (index) {
    const name = (id: string) => index.byId.get(id)?.name ?? id;
    cleaned.sort((a, b) => name(a.id).localeCompare(name(b.id)));
  }
  return { ...deck, [card.kind]: cleaned };
}

/** Expand counts into the per-copy lists the engine takes for `StartGame`. */
export function expand(deck: DeckCards): { crypt: string[]; library: string[] } {
  const flat = (cards: CardCount[]) => cards.flatMap((c) => Array<string>(c.count).fill(c.id));
  return { crypt: flat(deck.crypt), library: flat(deck.library) };
}

/** Import a deck from text (TWDA, VDB, Amaranth, Lackey) or KRCG/vtesdecks JSON. */
export function importDeck(input: string, index: CardIndex): ImportResult {
  const trimmed = input.trim();
  if (trimmed.startsWith('{')) {
    try {
      return importJson(JSON.parse(trimmed), index);
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      return { deck: emptyDeck(), issues: [{ text: '', message: 'Invalid JSON' }] };
    }
  }
  return importText(trimmed, index);
}

/** Lookup from every normalised name and alias to the cards that carry it. */
const nameMaps = new WeakMap<CardIndex, Map<string, CardRecord[]>>();
function namesOf(index: CardIndex): Map<string, CardRecord[]> {
  let map = nameMaps.get(index);
  if (!map) {
    map = new Map();
    for (const card of index.cards) {
      for (const n of new Set([card.name, card.printedName, ...card.aliases].map(normalizeName))) {
        map.set(n, [...(map.get(n) ?? []), card]);
      }
    }
    nameMaps.set(index, map);
  }
  return map;
}

/** Resolve a name, using the crypt group (`Clan:2`) to pick between same-named vampires. */
export function resolveName(
  name: string,
  index: CardIndex,
  group?: string,
): { card?: CardRecord; message?: string } {
  const matches = namesOf(index).get(normalizeName(name)) ?? [];
  const exact = matches.filter((c) => normalizeName(c.name) === normalizeName(name));
  let candidates = exact.length === 1 ? exact : matches;
  if (candidates.length > 1 && group) {
    const inGroup = candidates.filter((c) => c.group === group);
    if (inGroup.length) candidates = inGroup;
  }
  if (candidates.length > 1) {
    const plain = candidates.filter((c) => !c.advanced);
    if (plain.length === 1) candidates = plain;
  }
  if (candidates.length === 1) return { card: candidates[0] as CardRecord };
  if (candidates.length === 0) return { message: `Unknown card "${name}"` };
  return { message: `"${name}" could be ${candidates.map((c) => c.name).join(' or ')}` };
}

const COUNT_FIRST = /^(\d{1,3})\s*x?\s+(.+)$/i;
const COUNT_LAST = /^(.+?)\s+x\s*(\d{1,3})$/i;

function importText(text: string, index: CardIndex): ImportResult {
  const deck = emptyDeck();
  const issues: ImportIssue[] = [];
  let name: string | undefined;
  const counts = new Map<string, { card: CardRecord; count: number }>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || /^(#|\/\/|-{2,}|={2,})/.test(line)) return;
    const deckName = /^deck name:\s*(.+)$/i.exec(line);
    if (deckName) {
      name = deckName[1];
      return;
    }
    const m = COUNT_FIRST.exec(line) ?? COUNT_LAST.exec(line);
    const [count, rest] = m
      ? COUNT_FIRST.test(line)
        ? [Number(m[1]), m[2] ?? '']
        : [Number(m[2]), m[1] ?? '']
      : [1, line];
    // TWDA crypt lines: name, then columns separated by 2+ spaces, ending in "Clan:group".
    const group = /:(\d|ANY)\s*$/i.exec(rest)?.[1]?.toUpperCase();
    const cardName = (rest.split(/\t|\s{2,}/)[0] ?? '').trim();
    const { card, message } = resolveName(cardName, index, group);
    if (card) {
      const prev = counts.get(card.id);
      counts.set(card.id, { card, count: (prev?.count ?? 0) + count });
    } else if (m) {
      issues.push({ line: i + 1, text: line, message: message ?? 'Unknown card' });
    }
    // Lines without a count that aren't cards are headers ("Crypt (12 cards)", "Master (9)", …).
  });
  for (const { card, count } of counts.values()) deck[card.kind].push({ id: card.id, count });
  return name ? { deck, name, issues } : { deck, issues };
}

/** KRCG / vtesdecks JSON: any nested `{ id, count }` (or `{ name, count }`) entries. */
function importJson(json: unknown, index: CardIndex): ImportResult {
  const deck = emptyDeck();
  const issues: ImportIssue[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (typeof o.count === 'number' && (o.id !== undefined || typeof o.name === 'string')) {
      const card =
        index.byId.get(String(o.id)) ??
        (typeof o.name === 'string' ? resolveName(o.name, index).card : undefined);
      if (card) deck[card.kind].push({ id: card.id, count: o.count });
      else
        issues.push({ text: JSON.stringify(o), message: `Unknown card ${String(o.id ?? o.name)}` });
      return;
    }
    for (const [k, v] of Object.entries(o)) if (k !== 'name' && typeof v === 'object') walk(v);
  };
  walk(json);
  const name = (json as { name?: unknown }).name;
  return typeof name === 'string' ? { deck, name, issues } : { deck, issues };
}

/** TWDA-style text, which VDB, Amaranth and most tools import. */
export function exportText(deck: DeckCards, index: CardIndex, name?: string): string {
  const card = (id: string) => index.byId.get(id);
  const out: string[] = [];
  if (name) out.push(`Deck Name: ${name}`, '');
  const caps = deck.crypt.flatMap((c) => Array<number>(c.count).fill(card(c.id)?.capacity ?? 0));
  const avg = caps.length ? (caps.reduce((a, b) => a + b, 0) / caps.length).toFixed(2) : '0';
  out.push(
    `Crypt (${deckSize(deck.crypt)} cards, min=${Math.min(...caps, 0) || 0}, max=${Math.max(...caps, 0)}, avg=${avg})`,
  );
  const label = (id: string) => {
    const r = card(id);
    return r ? `${r.printedName}${r.advanced ? ' (ADV)' : ''}` : id;
  };
  const width = Math.max(0, ...deck.crypt.map((c) => label(c.id).length));
  for (const c of sortedBy(deck.crypt, index, (r) => -(r.capacity ?? 0))) {
    const r = card(c.id);
    if (!r) continue;
    const discs = (r.disciplines ?? []).join(' ');
    const title = r.title ?? '';
    out.push(
      `${c.count}x ${label(c.id).padEnd(width)}  ${String(r.capacity ?? '').padStart(2)}  ${discs.padEnd(20)}  ${title.padEnd(10)}  ${(r.clans ?? []).join('/')}:${r.group ?? ''}`.trimEnd(),
    );
  }
  out.push('', `Library (${deckSize(deck.library)} cards)`);
  const byType = new Map<string, CardCount[]>();
  for (const c of deck.library) {
    const type = card(c.id)?.types.join('/') ?? 'Unknown';
    byType.set(type, [...(byType.get(type) ?? []), c]);
  }
  for (const [type, cards] of [...byType].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`${type} (${deckSize(cards)})`);
    for (const c of sortedBy(cards, index, () => 0))
      out.push(`${c.count}x ${card(c.id)?.name ?? c.id}`);
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** KRCG-style JSON. */
export function exportJson(deck: DeckCards, index: CardIndex, name?: string): string {
  const entry = (c: CardCount) => ({
    id: Number(c.id),
    count: c.count,
    name: index.byId.get(c.id)?.name,
  });
  return `${JSON.stringify(
    {
      ...(name ? { name } : {}),
      crypt: { count: deckSize(deck.crypt), cards: deck.crypt.map(entry) },
      library: { count: deckSize(deck.library), cards: deck.library.map(entry) },
    },
    null,
    2,
  )}\n`;
}

function sortedBy(
  cards: CardCount[],
  index: CardIndex,
  key: (r: CardRecord) => number,
): CardCount[] {
  const r = (c: CardCount) => index.byId.get(c.id);
  return [...cards].sort((a, b) => {
    const ra = r(a);
    const rb = r(b);
    if (!ra || !rb) return 0;
    return key(ra) - key(rb) || b.count - a.count || ra.name.localeCompare(rb.name);
  });
}
