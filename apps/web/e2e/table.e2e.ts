/**
 * The main table flows in real browsers: every player in their own context, talking to the real
 * API and WebSocket server, so these also cover pushing events to each viewer.
 */
import { expect, type Page, test } from '@playwright/test';
import { signedIn, startGame, toMinionPhase, users, view } from './helpers.ts';

const flow = (page: Page) => page.getByRole('region', { name: 'Game flow' });
const calls = (page: Page) => page.getByRole('region', { name: 'Judge calls' });

test('a bleed: the prey decides not to block and the actor resolves it', async ({ browser }) => {
  const [alice, bob, carol] = users('alice', 'bob', 'carol');
  const game = await startGame([alice, bob, carol]);
  const { actor, prey } = await toMinionPhase(game.id, alice);
  const a = await signedIn(browser, actor);
  const p = await signedIn(browser, prey);
  await a.goto(`/games/${game.id}`);
  await p.goto(`/games/${game.id}`);

  await expect(flow(a)).toContainText('Your decision: Your minion phase');
  await flow(a).getByRole('button', { name: 'Bleed', exact: true }).click();
  await flow(a).getByRole('button', { name: 'Vera Nightfall' }).click();
  await flow(a).getByRole('button', { name: 'Confirm' }).click();

  await expect(flow(p)).toContainText(/Your decision: Block Vera Nightfall.s bleed\?/);
  await flow(p).getByRole('button', { name: 'Don’t block' }).click();

  await expect(flow(a)).toContainText('did it succeed?');
  await flow(a).getByRole('button', { name: 'Successful', exact: true }).click();
  // Bleed amount (default 1), then the Edge.
  await flow(a).getByRole('button', { name: 'OK' }).click();
  await flow(a).getByRole('button', { name: 'Take the Edge' }).click();
  await flow(a).getByRole('button', { name: 'Confirm' }).click();

  await expect(flow(a)).toContainText('Your decision: Your minion phase');
  await expect(flow(p)).not.toContainText('Your decision');
  await expect
    .poll(async () => (await view(prey, game.id)).seats.find((s) => s.occupant === prey)?.pool)
    .toBe(29);
});

test('a pause stops play until whoever paused resumes', async ({ browser }) => {
  const [alice, bob, carol] = users('alice', 'bob', 'carol');
  const game = await startGame([alice, bob, carol], { timeLimitMinutes: 30 });
  const a = await signedIn(browser, alice);
  const b = await signedIn(browser, bob);
  await a.goto(`/games/${game.id}`);
  await b.goto(`/games/${game.id}`);

  await flow(a).getByLabel('Pause length').selectOption('2');
  await flow(a).getByRole('button', { name: 'Pause' }).click();
  for (const page of [a, b]) {
    await expect(flow(page)).toContainText('The game is paused');
    await expect(flow(page)).toContainText(/paused by .* · [12]:\d\d/);
  }
  // Only the player who paused (or a judge) can lift it early.
  await expect(flow(b).getByRole('button', { name: 'Resume' })).toHaveCount(0);
  await flow(a).getByRole('button', { name: 'Resume' }).click();
  for (const page of [a, b]) await expect(flow(page)).not.toContainText('The game is paused');
});

test('a player calls a judge; a judge claims it from the queue and rules', async ({ browser }) => {
  const [alice, bob, carol, judge] = users('alice', 'bob', 'carol', 'judge');
  const game = await startGame([alice, bob, carol]);
  const a = await signedIn(browser, alice);
  await a.goto(`/games/${game.id}`);

  await calls(a).getByRole('button', { name: 'Call a judge' }).click();
  await calls(a).getByLabel('Reason').selectOption('rules');
  await calls(a).getByLabel('What happened').fill('Can I play this now?');
  await calls(a).getByRole('button', { name: 'Call', exact: true }).click();
  await expect(calls(a).getByRole('status')).toContainText('waiting for a judge');

  const j = await signedIn(browser, `${judge}:judge`);
  await j.goto('/judge');
  const entry = j.getByRole('listitem').filter({ hasText: game.name });
  await expect(entry).toContainText('Rules question');
  await expect(entry).toContainText('Can I play this now?');
  await entry.getByRole('button', { name: 'Claim' }).click();
  await expect(entry).toContainText('yours');
  await expect(calls(a).getByRole('status')).toContainText('a judge is handling it');

  await entry.getByRole('link', { name: game.name }).click();
  await calls(j).getByLabel('Ruling note').fill('Yes, during your master phase.');
  await calls(j).getByRole('button', { name: 'Rule' }).click();

  await expect(calls(a).getByRole('status')).toHaveCount(0);
  await expect(a.getByText('Yes, during your master phase.')).toBeVisible();
  await j.goto('/judge');
  await expect(j.getByRole('listitem').filter({ hasText: game.name })).toHaveCount(0);
});
