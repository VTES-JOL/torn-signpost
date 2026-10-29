/**
 * Runtime config and the card database (AD-07): the manifest, then the hash-named card file,
 * which the browser can cache indefinitely. Search runs in memory.
 */
import {
  type CardIndex,
  type CardRecord,
  type ContentManifest,
  cardImageUrl,
  createIndex,
  type ImageSize,
} from '@torn-signpost/cards';
import type { ClientConfig } from '@torn-signpost/protocol';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';

const ConfigContext = createContext<ClientConfig | undefined>(undefined);

export function ConfigProvider({
  config,
  children,
}: {
  config: ClientConfig;
  children: ReactNode;
}) {
  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}

export function useConfig(): ClientConfig {
  const config = useContext(ConfigContext);
  if (!config) throw new Error('useConfig outside ConfigProvider');
  return config;
}

export type Cards =
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | {
      state: 'ready';
      index: CardIndex;
      manifest: ContentManifest;
      image(id: string, size?: ImageSize): string;
      /** Card back, for scans that are missing. */
      back(kind: 'crypt' | 'library', size?: ImageSize): string;
      get(id: string): CardRecord | undefined;
    };

const CardsContext = createContext<Cards>({ state: 'loading' });

export function CardsProvider({ children }: { children: ReactNode }) {
  const { contentUrl } = useConfig();
  const [cards, setCards] = useState<Cards>({ state: 'loading' });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const manifestRes = await fetch(`${contentUrl}/data/manifest.json`, { cache: 'no-cache' });
        if (!manifestRes.ok) throw new Error(`Card data unavailable (HTTP ${manifestRes.status})`);
        const manifest = (await manifestRes.json()) as ContentManifest;
        const res = await fetch(`${contentUrl}/${manifest.cards}`);
        if (!res.ok) throw new Error(`Card data unavailable (HTTP ${res.status})`);
        const index = createIndex((await res.json()) as CardRecord[]);
        if (cancelled) return;
        setCards({
          state: 'ready',
          index,
          manifest,
          image: (id, size = 'full') => cardImageUrl(contentUrl, manifest, id, size),
          get: (id) => index.byId.get(id),
          back: (kind, size = 'full') =>
            `${contentUrl}/${manifest.images.backs[kind].replace('{size}', size)}`,
        });
      } catch (e) {
        if (!cancelled)
          setCards({ state: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contentUrl]);
  return <CardsContext.Provider value={cards}>{children}</CardsContext.Provider>;
}

export function useCards(): Cards {
  return useContext(CardsContext);
}
