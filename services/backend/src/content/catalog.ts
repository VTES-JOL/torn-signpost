/**
 * Card data for the server, loaded from the content CDN (architecture §5.5) and refreshed when the
 * manifest changes, so an admin can update cards without a deploy (DECK-01).
 */
import {
  type CardIndex,
  type CardRecord,
  type ContentManifest,
  createIndex,
} from '@torn-signpost/cards';
import { type CardCatalog, createCatalog } from '@torn-signpost/engine';

export interface CardSource {
  index: CardIndex;
  catalog: CardCatalog;
}

/** Resolves the current card data. */
export type Content = () => Promise<CardSource>;

export function staticContent(cards: readonly CardRecord[]): Content {
  const source = { index: createIndex(cards), catalog: createCatalog(cards) };
  return async () => source;
}

export function cdnContent(
  contentUrl: string,
  opts: { ttlMs?: number; fetch?: typeof fetch } = {},
): Content {
  const ttl = opts.ttlMs ?? 5 * 60_000;
  const get = opts.fetch ?? fetch;
  let current: { path: string; source: CardSource } | undefined;
  let checkedAt = 0;
  let pending: Promise<CardSource> | undefined;

  const json = async <T>(path: string): Promise<T> => {
    const res = await get(`${contentUrl}/${path}`);
    if (!res.ok) throw new Error(`Content ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  };

  const refresh = async (): Promise<CardSource> => {
    try {
      const manifest = await json<ContentManifest>('data/manifest.json');
      if (current?.path !== manifest.cards) {
        const cards = await json<CardRecord[]>(manifest.cards);
        current = {
          path: manifest.cards,
          source: { index: createIndex(cards), catalog: createCatalog(cards) },
        };
      }
      checkedAt = Date.now();
      return current.source;
    } catch (e) {
      // Keep serving the cards we have if the CDN hiccups.
      if (current) return current.source;
      throw e;
    } finally {
      pending = undefined;
    }
  };

  return async () => {
    if (current && Date.now() - checkedAt < ttl) return current.source;
    pending ??= refresh();
    return pending;
  };
}
