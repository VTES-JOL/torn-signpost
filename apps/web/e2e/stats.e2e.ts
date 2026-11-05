/** Results and stats (STATS-01..03): counted games on players' pages and the leaderboard. */
import { expect, test } from '@playwright/test';
import { api, occupant, signedIn, startGame, users, view } from './helpers.ts';

test('finished 5-player games show on the player’s page and the leaderboard', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const five = users('ana', 'bea', 'cy', 'dov', 'eli');
  const [ana] = five;
  let last = '';
  // Five games (the leaderboard's minimum), each won by Ana with 2½ VP.
  for (let i = 0; i < 5; i++) {
    const game = await startGame(five);
    const seat = (await view(ana, game.id)).seats.find((s) => s.occupant === ana)?.id;
    await api('jo:judge', 'POST', `/games/${game.id}/commands`, {
      commandId: `vp-${game.id}`,
      command: { type: 'AdjustVp', seat, delta: 2 },
    });
    await api('ada:admin', 'POST', `/games/${game.id}/commands`, {
      commandId: `end-${game.id}`,
      command: { type: 'EndGame' },
    });
    last = game.name;
    expect(occupant(await view(ana, game.id), seat)).toBe(ana);
  }

  const page = await signedIn(browser, ana);
  await page.goto(`/players/${ana}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(ana);
  const allTime = page.getByRole('region', { name: 'All time' });
  await expect(allTime).toContainText('Games5');
  await expect(allTime).toContainText('Game wins5');
  await expect(allTime).toContainText('Win rate100%');
  await expect(page.getByText('Toreador (5)')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: last })).toContainText(
    'game win · still in',
  );

  await page.getByRole('link', { name: 'Leaderboards' }).click();
  const row = page.getByRole('row').filter({ hasText: ana });
  await expect(row).toContainText('5');
  await row.getByRole('link', { name: ana }).click();
  await expect(page).toHaveURL(new RegExp(`/players/${ana}$`));
});
