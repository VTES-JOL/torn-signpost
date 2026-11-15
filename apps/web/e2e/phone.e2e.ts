/**
 * The game on a phone (styles.css, max-width 760px): it fits the screen, with the decision bar,
 * your seat and your hand all in view; opponents fold to one line until opened; the log, the card
 * menu and the site menu open as sheets.
 */
import { expect, test } from '@playwright/test';
import { signedIn, startGame, toMinionPhase, users } from './helpers.ts';

test('the game fits a phone screen, with the rest a tap away', async ({ browser }) => {
  const [alice, bob, carol] = users('alice', 'bob', 'carol');
  const game = await startGame([alice, bob, carol]);
  const { actor, prey } = await toMinionPhase(game.id, alice);
  const page = await signedIn(browser, actor);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/games/${game.id}`);
  // A new player is asked for a display name: a slim line that leaves the game on screen.
  const banner = page.getByRole('region', { name: 'Choose a display name' });
  await expect(banner).toBeVisible();
  expect((await banner.boundingBox())?.height ?? 0).toBeLessThan(90);

  // What you act on is on screen without scrolling: the decision, your seat, your hand.
  const flow = page.getByRole('region', { name: 'Game flow' });
  await expect(flow).toContainText('Your decision: Your minion phase');
  await expect(flow).toBeInViewport();
  await expect(
    page.getByRole('region', { name: new RegExp(`Seat .*: ${actor}`) }),
  ).toBeInViewport();
  // All of the hand, with the name banner above the game.
  await expect(page.locator('.hand')).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // An opponent is one line, then all their cards on a tap.
  const preySeat = page.getByRole('region', { name: new RegExp(`Seat .*: ${prey}`) });
  await expect(preySeat).toContainText('1 ready');
  await expect(preySeat.getByText('Ready', { exact: true })).toBeHidden();
  await preySeat.getByRole('button', { name: `Show ${prey}'s cards` }).click();
  await expect(preySeat.getByText('Ready', { exact: true })).toBeVisible();
  await expect(preySeat.getByRole('button', { name: 'Vera Nightfall' })).toBeVisible();

  // A card in your hand: a sheet with the card and what you can do with it.
  await page.locator('.hand .card').first().click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeInViewport();
  await expect(menu.getByRole('menuitem', { name: 'Play', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // The log and chat: a sheet over the table.
  const side = page.getByRole('complementary', { name: 'Log, chat and console' });
  await expect(side).toBeHidden();
  await page.getByRole('button', { name: 'Log & chat' }).click();
  await expect(side.getByRole('list', { name: 'Game log and chat' })).toContainText('Game started');
  await side.getByRole('button', { name: 'Close' }).click();
  await expect(side).toBeHidden();
  // Or a tap on the dimmed table behind it.
  await page.getByRole('button', { name: 'Log & chat' }).click();
  await expect(side).toBeVisible();
  // The sheet covers its middle: tap near the top.
  await page.getByRole('button', { name: 'Close the log' }).click({ position: { x: 195, y: 20 } });
  await expect(side).toBeHidden();

  // Choosing a name opens the form; putting it off hides the banner.
  await banner.getByRole('button', { name: 'Choose…' }).click();
  await expect(banner.getByLabel('Display name')).toBeVisible();
  await banner.getByRole('button', { name: 'Later' }).click();
  await expect(banner).toBeHidden();

  // The site's menu folds behind one button.
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav).toBeHidden();
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(nav.getByRole('link', { name: 'Games' })).toBeVisible();
});
