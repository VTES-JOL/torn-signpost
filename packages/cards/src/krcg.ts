/** Turns KRCG card data (static.krcg.org/data/vtes.json) into content-pack card records. */
import { type CardRecord, SECTS } from './model.ts';

/** The fields of a KRCG card that the content pack uses. */
export interface KrcgCard {
  id: number;
  name: string;
  printed_name: string;
  types: string[];
  clans?: string[];
  disciplines?: string[];
  multidisc?: boolean;
  combo?: boolean;
  capacity?: number;
  group?: string;
  title?: string;
  adv?: boolean;
  card_text: string;
  blood_cost?: string;
  pool_cost?: string;
  conviction_cost?: string;
  sets: Record<string, unknown>;
  legality: string;
  banned?: string;
  name_variants?: string[];
  aka?: string[];
  artists?: string[];
}

/**
 * The V5 card pool: cards printed in V5-branded products. Kept in the manifest so it can be
 * corrected without a code change.
 */
export const DEFAULT_V5_SETS = [
  'Fifth Edition',
  'Fifth Edition (Anarch)',
  'Fifth Edition (Companion)',
  'Sabbat V5',
  'V5 Polish Edition promo',
];

const CRYPT_TYPES = new Set(['Vampire', 'Imbued']);

export function fromKrcg(card: KrcgCard, v5Sets: readonly string[] = DEFAULT_V5_SETS): CardRecord {
  const kind = card.types.some((t) => CRYPT_TYPES.has(t)) ? 'crypt' : 'library';
  const sets = Object.keys(card.sets);
  const record: CardRecord = {
    id: String(card.id),
    name: card.name,
    printedName: card.printed_name,
    kind,
    types: card.types,
    text: card.card_text,
    sets,
    legalFrom: card.legality,
    v5: sets.some((s) => v5Sets.includes(s)),
    aliases: [
      ...new Set([...(card.name_variants ?? []), ...(card.aka ?? []), card.printed_name]),
    ].filter((n) => n !== card.name),
    artists: card.artists ?? [],
  };
  const optional: { [K in keyof CardRecord]?: CardRecord[K] | undefined } = {
    clans: card.clans,
    disciplines: card.disciplines,
    capacity: card.capacity,
    group: card.group,
    title: card.title,
    bloodCost: card.blood_cost,
    poolCost: card.pool_cost,
    convictionCost: card.conviction_cost,
    bannedFrom: card.banned,
  };
  if (card.adv) optional.advanced = true;
  if (kind === 'library' && (card.disciplines?.length ?? 0) > 1) {
    optional.disciplineMode = card.combo ? 'all' : 'any';
  }
  if (card.types.includes('Vampire')) optional.sect = sectOf(card.card_text);
  for (const [k, v] of Object.entries(optional)) {
    if (v !== undefined) (record as unknown as Record<string, unknown>)[k] = v;
  }
  return record;
}

/** A vampire's sect is named in the first clause of its text ("Advanced, Sabbat: …"). */
export function sectOf(text: string): string | undefined {
  const first = text.split(/[.:\n]/)[0] ?? '';
  return SECTS.find((s) => new RegExp(`\\b${s}\\b`).test(first));
}
