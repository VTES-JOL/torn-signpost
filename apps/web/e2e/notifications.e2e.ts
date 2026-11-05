/** In-app notifications (NOTIF-01) reach a player wherever they are on the site. */
import { expect, test } from '@playwright/test';
import { api, signedIn, startGame, users, view } from './helpers.ts';

test('a player elsewhere on the site is notified, and the notification opens the game', async ({
  browser,
}) => {
  const [alice, bob, carol] = users('alice', 'bob', 'carol');
  const b = await signedIn(browser, bob);
  await b.goto('/games');
  const bell = b.getByRole('button', { name: /^Notifications/ });
  await expect(bell).toHaveAccessibleName('Notifications');

  const game = await startGame([alice, bob, carol]);
  await expect(bell).toHaveAccessibleName(/Notifications, \d+ unread/);
  await expect(b).toHaveTitle(/^\(\d+\) /);

  await bell.click();
  const panel = b.getByRole('region', { name: 'Notifications' });
  const started = panel.getByRole('link').filter({ hasText: 'The game has started' });
  await expect(started).toContainText(game.name);
  await started.click();
  await expect(b).toHaveURL(new RegExp(`/games/${game.id}$`));
  // Opening the game marks everything about it read (before Bob shows as present).
  await expect
    .poll(async () => (await view(alice, game.id)).seats.find((s) => s.occupant === bob)?.present)
    .toBe(true);
  await expect(bell).toHaveAccessibleName('Notifications');

  // A mention in chat, while Bob is at the table.
  await api(alice, 'POST', `/games/${game.id}/chat`, { text: `over to you @${bob}` });
  await bell.click();
  await expect(panel.getByRole('link').first()).toContainText(
    `mentioned you: “over to you @${bob}”`,
  );
  await panel.getByRole('button', { name: 'Mark all read' }).click();
  await expect(bell).toHaveAccessibleName('Notifications');
  await expect(b).not.toHaveTitle(/^\(\d+\) /);
});
