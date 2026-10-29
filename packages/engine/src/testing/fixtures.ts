import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CardInfo, createCatalog } from '../catalog.ts';

export const SCENARIO_DIR = join(import.meta.dirname, '../../scenarios');

/** The invented test catalog shared by unit tests and scenarios. */
export const testCatalog = createCatalog(
  (JSON.parse(readFileSync(join(SCENARIO_DIR, 'catalog.json'), 'utf8')) as { cards: CardInfo[] })
    .cards,
);

export function scenarioFiles(): { name: string; source: string }[] {
  return readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith('.scenario'))
    .sort()
    .map((name) => ({ name, source: readFileSync(join(SCENARIO_DIR, name), 'utf8') }));
}
