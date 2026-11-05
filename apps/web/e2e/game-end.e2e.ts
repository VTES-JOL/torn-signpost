/** The end of a game (GAME-08/09): ending early, and the final standings for everyone. */
import { expect, type Page, test } from '@playwright/test';
import { signedIn, startGame, users, view } from './helpers.ts';

const ending = (page: Page) => page.getByRole('region', { name: 'End the game' });
const over = (page: Page) => page.getByRole('region', { name: 'Game over' });

test('the players of a casual game agree to end it; everyone sees the result', async ({
  browser,
}) => {
  const [alice, bob, carol, sam] = users('alice', 'bob', 'carol', 'sam');
  const game = await startGame([alice, bob, carol]);
  const pages = await Promise.all([alice, bob, carol].map((u) => signedIn(browser, u)));
  const watcher = await signedIn(browser, sam);
  for (const p of [...pages, watcher]) await p.goto(`/games/${game.id}`);
  const [a, b, c] = pages as [Page, Page, Page];

  await ending(a).getByRole('button', { name: 'Propose ending the game' }).click();
  await expect(ending(b)).toContainText('proposes ending the game');
  await ending(b).getByRole('button', { name: 'Agree' }).click();
  await expect(ending(c)).toContainText(`waiting for ${carol}`);
  await ending(c).getByRole('button', { name: 'Agree' }).click();

  for (const p of [a, watcher]) {
    await expect(over(p)).toContainText('Ended by agreement');
    await expect(over(p)).toContainText('nobody wins');
    await expect(over(p).getByRole('row')).toHaveCount(4);
  }
  expect((await view(alice, game.id)).status).toBe('finished');
});

test('an admin ends a game from the table; judges cannot', async ({ browser }) => {
  const [alice, bob, carol, judge, admin] = users('alice', 'bob', 'carol', 'jo', 'ada');
  const game = await startGame([alice, bob, carol]);
  const j = await signedIn(browser, `${judge}:judge`);
  const ad = await signedIn(browser, `${admin}:admin`);
  const a = await signedIn(browser, alice);
  for (const p of [j, ad, a]) await p.goto(`/games/${game.id}`);
  await expect(ending(j)).toHaveCount(0);
  await ending(ad).getByRole('button', { name: 'End the game…' }).click();
  await ending(ad).getByRole('button', { name: 'End the game', exact: true }).click();
  await expect(over(a)).toContainText('Ended by an admin');
  await expect(ending(a)).toHaveCount(0);
});
