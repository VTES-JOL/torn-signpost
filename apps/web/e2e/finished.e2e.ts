/** The finished game (docs/m6-plan.md M6.6, GAME-16): live for spectators, listed, and its result. */
import { expect, type Page, test } from '@playwright/test';
import { api, signedIn, startGame, users } from './helpers.ts';

const over = (page: Page) => page.getByRole('region', { name: 'Game over' });
const end = (gameId: string) =>
  api('ada:admin', 'POST', `/games/${gameId}/commands`, {
    commandId: `end-${gameId}`,
    command: { type: 'EndGame' },
  });

test('a guest watching sees the game end live, then finds it under Recent results', async ({
  browser,
}) => {
  const [alice, bob, carol] = users('alice', 'bob', 'carol');
  const game = await startGame([alice, bob, carol]);
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(`/games/${game.id}`);
  await expect(guest.getByText('spectating')).toBeVisible();
  await expect(over(guest)).toHaveCount(0);

  await end(game.id);
  await expect(over(guest)).toContainText('Ended by an admin');
  await expect(over(guest).getByRole('row')).toHaveCount(4);
  await expect(guest.getByText('The game is over: ended by an admin')).toBeVisible();

  await guest.goto('/games');
  const recent = guest.getByRole('listitem').filter({ hasText: game.name });
  await expect(recent).toContainText('nobody won');
  await expect(recent).toContainText(`${alice} ½`);
  await expect(recent).not.toContainText('counted');
});

test('a finished table offers its players nothing more to do', async ({ browser }) => {
  const [alice, bob, carol] = users('alice', 'bob', 'carol');
  const game = await startGame([alice, bob, carol]);
  const page = await signedIn(browser, alice);
  await page.goto(`/games/${game.id}`);
  await expect(page.getByText(/you are seat/)).toBeVisible();
  await expect(page.getByText(/^Hand \(/)).toBeVisible();

  await end(game.id);
  await expect(over(page)).toBeVisible();
  await expect(page.getByText(/finished · you were seat/)).toBeVisible();
  await expect(page.getByText(/^Hand \(/)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Game flow' }).getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /pool$/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Console (`)' }).click();
  await expect(
    page.getByText('The game is over: the console takes no more commands.'),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Console command' })).toHaveCount(0);
});

test('anyone can see a private counted game’s result, but not its table', async ({ browser }) => {
  const five = users('ana', 'bea', 'cy', 'dov', 'eli');
  const [stranger] = users('stranger');
  const game = await startGame(five, { visibility: 'private' });
  await end(game.id);

  const page = await signedIn(browser, stranger);
  await page.goto(`/games/${game.id}`);
  const result = page.getByRole('region', { name: 'Result' });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(game.name);
  await expect(result).toContainText('Ended by an admin');
  await expect(result.getByRole('row')).toHaveCount(6);
  await expect(page.getByRole('region', { name: 'Game flow' })).toHaveCount(0);
  // From a player's page, too (STATS-02).
  await page.goto(`/players/${five[0]}`);
  await page.getByRole('link', { name: game.name }).click();
  await expect(result).toContainText('nobody wins');
});
