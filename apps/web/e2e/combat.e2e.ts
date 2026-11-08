/** Combat steps (GAME-07, docs/m6-plan.md M6.4a): a round fought through the combat panel. */

import { expect, type Page, test } from '@playwright/test';
import { zoneId } from '@torn-signpost/engine';
import { send, signedIn, startGame, toMinionPhase, users, view } from './helpers.ts';

const flow = (page: Page) => page.getByRole('region', { name: 'Game flow' });
const log = (page: Page) => page.getByLabel('Game log and chat');

test('a blocked bleed is fought step by step, and everyone reads each step in the log', async ({
  browser,
}) => {
  // Some 20 commands, each pushed to three pages: slow when other tests share the API.
  test.setTimeout(60_000);
  const [alice, bob, carol] = users('alice', 'bob', 'carol');
  const game = await startGame([alice, bob, carol]);
  const { actor, prey } = await toMinionPhase(game.id, alice);
  const watcher = [alice, bob, carol].find((u) => u !== actor && u !== prey) ?? '';
  const a = await signedIn(browser, actor);
  const p = await signedIn(browser, prey);
  const w = await signedIn(browser, watcher);
  for (const page of [a, p, w]) await page.goto(`/games/${game.id}`);

  // A bleeds; the prey blocks; both let the block stand.
  await flow(a).getByRole('button', { name: 'Bleed', exact: true }).click();
  await flow(a).getByRole('button', { name: 'Vera Nightfall' }).click();
  await flow(a).getByRole('button', { name: 'Confirm' }).click();
  await flow(p).getByRole('button', { name: 'Block', exact: true }).click();
  await flow(p).getByRole('button', { name: 'Vera Nightfall' }).click();
  await flow(p).getByRole('button', { name: 'Confirm' }).click();
  await flow(a).getByRole('button', { name: 'Pass', exact: true }).click();
  await expect(flow(p)).toContainText('Your decision');
  await flow(p).getByRole('button', { name: 'Pass', exact: true }).click();

  // Combat: both pass straight to the strikes.
  const panel = (page: Page) => flow(page).getByRole('region', { name: 'Combat' });
  await expect(panel(w)).toContainText('Combat · round 1');
  await expect(flow(a)).toContainText('Your decision: Combat, Round 1 · Before range');
  await flow(a).getByRole('button', { name: 'Pass to strikes' }).click();
  await expect(flow(p)).toContainText('Your decision: Combat, Round 1 · Before range');
  await flow(p).getByRole('button', { name: 'Pass to strikes' }).click();
  await expect(flow(a)).toContainText('Your decision: Combat, Round 1 · Strikes: choose a strike');
  await expect(flow(p)).toContainText('Waiting on');

  // The acting minion strikes first, then the blocker.
  await flow(a).getByRole('button', { name: 'Hand strike' }).click();
  await flow(a).getByRole('button', { name: 'OK' }).click();
  await flow(a).getByRole('button', { name: 'Confirm' }).click();
  await expect(flow(p)).toContainText('Your decision: Combat, Round 1 · Strikes: choose a strike');
  await expect(panel(p)).toContainText('a hand strike for 1');
  await flow(p).getByRole('button', { name: 'Dodge…' }).click();
  await flow(p).getByRole('button', { name: 'None' }).click();
  await flow(p).getByRole('button', { name: 'Confirm' }).click();
  await expect(log(w)).toContainText(
    'Round 1 · Strikes: Vera Nightfall strikes: a hand strike for 1',
  );
  await expect(log(w)).toContainText('Round 1 · Strikes: Vera Nightfall strikes: dodge');

  // Damage onwards: both pass to the end of the round, and the combat is over.
  await expect(panel(a).locator('[aria-current="step"]')).toHaveText('Damage');
  await flow(a).getByRole('button', { name: 'Pass to the end of the round' }).click();
  // Wait for the impulse to arrive: the buttons change as it does.
  await expect(flow(p)).toContainText('Your decision: Combat, Round 1 · Damage');
  await flow(p).getByRole('button', { name: 'Pass to the end of the round' }).click();
  await expect(flow(a)).toContainText('Your decision: Your minion phase');
  await expect(log(w)).toContainText('Combat is over; the action was blocked');
  await expect(panel(w)).toHaveCount(0);
  expect((await view(actor, game.id)).action).toBeUndefined();
});

test('damage: the blocker prevents it, and the attacker, with no blood to mend, goes to torpor', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const [alice, bob, carol] = users('alice', 'bob', 'carol');
  const game = await startGame([alice, bob, carol]);
  const { actor, prey } = await toMinionPhase(game.id, alice);
  // Set up to the strikes through the API: not what's under test.
  const start = await view(actor, game.id);
  const seatOf = (u: string) => start.seats.find((x) => x.occupant === u)?.id ?? '';
  const minion = (u: string) => start.zones[zoneId(seatOf(u), 'ready')]?.[0] ?? '';
  await send(actor, game.id, { type: 'DeclareAction', kind: 'bleed', minion: minion(actor) });
  await send(prey, game.id, { type: 'Block', minion: minion(prey) });
  await send(actor, game.id, { type: 'Pass' });
  await send(prey, game.id, { type: 'Pass' });
  await send(actor, game.id, { type: 'PassUntil', until: 'strikes' });
  await send(prey, game.id, { type: 'PassUntil', until: 'strikes' });
  await send(actor, game.id, { type: 'Strike', kind: 'hand', amount: 1 });
  await send(prey, game.id, { type: 'Strike', kind: 'hand', amount: 1 });

  const a = await signedIn(browser, actor);
  const p = await signedIn(browser, prey);
  for (const page of [a, p]) await page.goto(`/games/${game.id}`);
  const panel = (page: Page) => flow(page).getByRole('region', { name: 'Combat' });
  await expect(panel(p)).toContainText('about to take 1 damage');
  await flow(a).getByRole('button', { name: 'Pass', exact: true }).click();
  await expect(flow(p)).toContainText('Your decision: Combat, Round 1 · Damage: prevent damage');
  await flow(p).getByRole('button', { name: 'Prevent damage…' }).click();
  await flow(p).getByRole('button', { name: 'OK' }).click();
  await flow(p).getByRole('button', { name: 'None' }).click();
  await flow(p).getByRole('button', { name: 'Confirm' }).click();
  await expect(panel(a)).toContainText('(1 prevented)');
  await expect(flow(a)).toContainText('Your decision');
  await flow(a).getByRole('button', { name: 'Pass', exact: true }).click();
  await expect(flow(p)).toContainText('Your decision');
  await flow(p).getByRole('button', { name: 'Pass', exact: true }).click();

  await expect(log(p)).toContainText('Round 1 · Damage: Vera Nightfall takes no damage');
  await expect(log(p)).toContainText(
    'Round 1 · Damage: Vera Nightfall takes 1 damage and goes to torpor',
  );
  await expect(panel(p)).toContainText('in torpor');
  await expect(panel(p)).toContainText('The combat ends after this round');
  await expect
    .poll(async () => (await view(actor, game.id)).zones[zoneId(seatOf(actor), 'torpor')]?.length)
    .toBe(1);
});
