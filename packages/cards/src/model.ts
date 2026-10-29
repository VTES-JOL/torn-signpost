/**
 * Card records as published in the content pack (architecture §5.5). The content pack is built
 * from KRCG data at ingest time and served from the content CDN; none of it is committed here
 * (LEGAL-08). `CardRecord` extends the engine's minimal `CardInfo`.
 */
import type { CardInfo } from '@torn-signpost/engine';

export interface CardRecord extends CardInfo {
  /** VEKN card ID, as a string. */
  id: string;
  /** Unique name, including group and advanced markers, e.g. "Theo Bell (G2 ADV)". */
  name: string;
  /** Name as printed on the card. */
  printedName: string;
  kind: 'crypt' | 'library';
  types: string[];
  clans?: string[];
  /**
   * Crypt: the vampire's disciplines, upper case for superior (`AUS`), lower case for inferior
   * (`aus`). Library: the disciplines the card requires, per `disciplineMode`.
   */
  disciplines?: string[];
  /** Library cards needing several disciplines: any one of them, or all together. */
  disciplineMode?: 'any' | 'all';
  capacity?: number;
  /** Crypt group, `1`…`7` or `ANY`. */
  group?: string;
  sect?: string;
  title?: string;
  advanced?: boolean;
  text: string;
  bloodCost?: string;
  poolCost?: string;
  convictionCost?: string;
  sets: string[];
  /** First date the card was tournament legal (ISO date). */
  legalFrom: string;
  /** Date the card was banned, if it is. */
  bannedFrom?: string;
  /** Part of the V5 card pool (DECK-04). */
  v5: boolean;
  /** Other names the card is known by, for import matching. */
  aliases: string[];
  artists: string[];
}

/** `data/manifest.json` on the content CDN: the only file that isn't immutable. */
export interface ContentManifest {
  schema: 1;
  generatedAt: string;
  source: { name: string; url: string; lastModified?: string };
  /** Path of the hash-named card data file, relative to the content origin. */
  cards: string;
  count: number;
  images: {
    /** e.g. `cards/{id}/{size}.webp` */
    pattern: string;
    sizes: Record<'thumb' | 'full', number>;
    backs: Record<'crypt' | 'library', string>;
  };
  formats: { v5Sets: string[] };
}

export type ImageSize = keyof ContentManifest['images']['sizes'];

export function cardImageUrl(
  contentUrl: string,
  manifest: ContentManifest,
  id: string,
  size: ImageSize = 'full',
): string {
  return `${contentUrl}/${manifest.images.pattern.replace('{id}', id).replace('{size}', size)}`;
}

export const SECTS = ['Camarilla', 'Sabbat', 'Independent', 'Anarch', 'Laibon'] as const;
