import { describe, expect, it } from 'vitest';
import { runScenario } from './scenario.ts';
import { localContentCatalog, REAL_CARD_SCENARIO_DIR, scenarioFiles } from './testing/fixtures.ts';

// Real cards need the content pack, which is never committed: skipped where there isn't one.
const catalog = localContentCatalog();

describe.skipIf(!catalog)('real-card scenarios', () => {
  it.each(scenarioFiles(REAL_CARD_SCENARIO_DIR))('$name', ({ source }) => {
    const run = runScenario(source, catalog ?? (undefined as never));
    expect(run.failure).toBeUndefined();
  });
});
