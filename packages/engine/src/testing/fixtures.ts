import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CardCatalog, type CardInfo, createCatalog } from '../catalog.ts';

export const SCENARIO_DIR = join(import.meta.dirname, '../../scenarios');

/** The invented test catalog shared by unit tests and scenarios. */
export const testCatalog = createCatalog(
  (JSON.parse(readFileSync(join(SCENARIO_DIR, 'catalog.json'), 'utf8')) as { cards: CardInfo[] })
    .cards,
);

export function scenarioFiles(dir = SCENARIO_DIR): { name: string; source: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.scenario'))
    .sort()
    .map((name) => ({ name, source: readFileSync(join(dir, name), 'utf8') }));
}

/** Scenarios written with real cards, by VEKN ID; they need the content pack to run. */
export const REAL_CARD_SCENARIO_DIR = join(SCENARIO_DIR, 'real-cards');

/**
 * The real card catalog from a local content pack (`pnpm content:ingest` writes it to
 * `content-pack/data`), or undefined when there isn't one, as in CI. Never committed (LEGAL-08).
 */
export function localContentCatalog(): CardCatalog | undefined {
  const dir = join(import.meta.dirname, '../../../../content-pack/data');
  const manifestFile = join(dir, 'manifest.json');
  if (!existsSync(manifestFile)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { cards: string };
  const file = join(dir, manifest.cards.replace(/^data\//, ''));
  const data = JSON.parse(readFileSync(file, 'utf8')) as CardInfo[] | { cards: CardInfo[] };
  return createCatalog(Array.isArray(data) ? data : data.cards);
}
