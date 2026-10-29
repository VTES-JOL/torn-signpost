import { describe, expect, it } from 'vitest';
import { runScenario } from './scenario.ts';
import { scenarioFiles, testCatalog } from './testing/fixtures.ts';

describe('golden scenarios', () => {
  it.each(scenarioFiles())('$name', ({ source }) => {
    const run = runScenario(source, testCatalog);
    expect(run.failure).toBeUndefined();
  });

  it('reports the failing line', () => {
    const run = runScenario('seat A a\nseat B b\nseat C c\nstart\nexpect pool A 29', testCatalog);
    expect(run.failure).toMatchObject({ line: 5, message: 'Expected A pool to be 29, got 30' });
  });
});
