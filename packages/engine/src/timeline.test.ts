import { describe, expect, it } from 'vitest';
import { runScenario } from './scenario.ts';
import { testCatalog } from './testing/fixtures.ts';
import { timelineFromEvents, timelineStates } from './timeline.ts';

const SCRIPT = 'seat A a\nseat B b\nseat C c\nstart\nA> pool -1\nA> next\nexpect pool A 29';

describe('timeline', () => {
  it('groups a recorded event log into one step per command', () => {
    const run = runScenario(SCRIPT, testCatalog);
    const timeline = timelineFromEvents(run.events);
    expect(timeline.steps[0]).toMatchObject({ kind: 'setup', text: 'GameStarted', from: 0 });
    // Every command's events share a timestamp and actor, so the step count matches the commands.
    const commands = run.steps.filter((s) => s.kind === 'command' && s.to > s.from);
    expect(timeline.steps).toHaveLength(commands.length);
    expect(timeline.steps.at(-1)?.to).toBe(run.events.length);
  });

  it('rebuilds the state after every event', () => {
    const run = runScenario(SCRIPT, testCatalog);
    const states = timelineStates(run);
    expect(states).toHaveLength(run.events.length + 1);
    expect(states[0]?.status).toBe('setup');
    expect(states.at(-1)).toEqual(run.state);
  });
});
