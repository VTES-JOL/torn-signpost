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

  it('records a step per line, with the events each command added', () => {
    const run = runScenario(
      '# a comment\nseat A a\nseat B b\nseat C c\nstart\n\nA> pool -1\nexpect pool A 29',
      testCatalog,
    );
    expect(run.failure).toBeUndefined();
    expect(run.steps.map((s) => [s.line, s.kind, s.to - s.from])).toEqual([
      [2, 'setup', 0],
      [3, 'setup', 0],
      [4, 'setup', 0],
      [5, 'command', 1],
      [7, 'command', 1],
      [8, 'check', 0],
    ]);
    expect(run.steps.at(-1)?.to).toBe(run.events.length);
  });

  it('marks the failing step', () => {
    const run = runScenario('seat A a\nseat B b\nseat C c\nstart\nexpect pool A 29', testCatalog);
    expect(run.steps.at(-1)).toMatchObject({
      line: 5,
      failure: 'Expected A pool to be 29, got 30',
    });
  });

  it('accepts card IDs in deck lists', () => {
    const run = runScenario(
      'seat A a\nseat B b\nseat C c\ncrypt A t-vera *4\nlibrary A t-feed *7\nstart\nexpect count A:hand 7',
      testCatalog,
    );
    expect(run.failure).toBeUndefined();
  });
});
