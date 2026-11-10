import { type CardInfo, createCatalog, runScenario } from '@torn-signpost/engine';
import testCards from '@torn-signpost/engine/test-catalog.json';
import { describe, expect, it } from 'vitest';
import { ReplayClient } from './ReplayClient.ts';
import { leadingComment } from './scenarios.ts';

const catalog = createCatalog((testCards as { cards: CardInfo[] }).cards);
const SCRIPT = `seed 4
seat A alice
seat B bob
seat C carol
crypt A "Vera Nightfall" *6
library A "Iron Ward" *12
crypt B "Tomas Grey" *6
library B "Quick Feed" *12
crypt C "Ilse Várga" *6
library C "Night Errand" *12
start
A> pool -1
A> draw
expect pool A 29`;

const client = () => {
  const run = runScenario(SCRIPT, catalog);
  expect(run.failure).toBeUndefined();
  return new ReplayClient(run, catalog);
};
const hidden = (c: ReplayClient, zone: string) =>
  (c.getSnapshot().view.zones[zone as never] ?? []).filter(
    (id) => !c.getSnapshot().view.cards[id]?.cardId,
  ).length;

describe('ReplayClient', () => {
  it('steps through the timeline', () => {
    const c = client();
    expect(c.getPosition()).toMatchObject({ cursor: 0 });
    expect(c.getSnapshot().view.status).toBe('setup');
    c.goto(11); // through `start`
    expect(c.getSnapshot().view.status).toBe('active');
    c.goto(12);
    expect(c.getSnapshot().view.seats[0]?.pool).toBe(29);
    c.goto(99);
    expect(c.getPosition().cursor).toBe(c.getPosition().steps.length);
    c.goto(11);
    expect(c.getSnapshot().view.seats[0]?.pool).toBe(30);
  });

  it('shows each viewer only what they could see', () => {
    const c = client();
    c.goto(11);
    c.setViewer({ kind: 'player', seat: 'A' });
    expect(hidden(c, 'A:hand')).toBe(0);
    expect(hidden(c, 'B:hand')).toBe(7);
    c.setViewer({ kind: 'judge' });
    expect(hidden(c, 'B:hand')).toBe(7);
    c.setViewer({ kind: 'server' });
    expect(hidden(c, 'B:hand')).toBe(0);
    c.setViewer({ kind: 'spectator' });
    expect(hidden(c, 'A:hand')).toBe(7);
    // The log is redacted too: the draw is named only for its owner.
    c.goto(13);
    expect(c.getSnapshot().log.at(-1)?.text).toBe('alice drew 1 card from their library');
  });

  it('plays on from any step, setting the rest of the script aside until reset', async () => {
    const c = client();
    c.setViewer({ kind: 'player', seat: 'B' });
    c.goto(11);
    await c.send({ type: 'AdjustPool', seat: 'B', delta: -3 });
    const { steps, cursor } = c.getPosition();
    expect(cursor).toBe(12);
    expect(steps.at(-1)).toMatchObject({ live: true, text: 'B> AdjustPool' });
    expect(c.getSnapshot().view.seats[1]?.pool).toBe(27);
    expect(c.getSnapshot().log.at(-1)?.text).toContain('bob');
    await expect(c.send({ type: 'Draw', seat: 'A' })).rejects.toMatchObject({ code: 'forbidden' });
    c.reset();
    expect(c.getPosition()).toMatchObject({ cursor: 11 });
    expect(c.getPosition().steps.some((s) => 'live' in s)).toBe(false);
    expect(c.getSnapshot().view.seats[1]?.pool).toBe(30);
  });

  it('only lets seats and the judge play', async () => {
    const c = client();
    c.goto(11);
    c.setViewer({ kind: 'spectator' });
    await expect(c.send({ type: 'AdjustPool', seat: 'A', delta: 1 })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

describe('leadingComment', () => {
  it('takes the first sentence of the opening comment, across lines', () => {
    const source =
      '# The rulebook examples: Chrysanthemum steals from a Stray, and\n# Nassir goes to torpor (vekn.net/rulebook). More here.\n# Next line.\nseed 5\n';
    expect(leadingComment(source)).toBe(
      'The rulebook examples: Chrysanthemum steals from a Stray, and Nassir goes to torpor (vekn.net/rulebook).',
    );
    expect(leadingComment('# Theo Bell and his .44 Magnum against Beast\nseed 1')).toBe(
      'Theo Bell and his .44 Magnum against Beast',
    );
  });
});
