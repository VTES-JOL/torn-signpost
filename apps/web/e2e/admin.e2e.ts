/** Escalations (GAME-19): a judge refers a casual game to the admins, and an admin replaces a player. */
import { expect, test } from '@playwright/test';
import { api, send, signedIn, startGame, users, view } from './helpers.ts';

test('an admin replaces a player from the admin queue after a judge escalates', async ({
  browser,
}) => {
  const [alice, bob, carol, dana, judge, admin] = users(
    'alice',
    'bob',
    'carol',
    'dana',
    'jo',
    'ada',
  );
  const game = await startGame([alice, bob, carol]);
  // Dana is willing to take over, under the display name she chose.
  await api(dana, 'PUT', '/me', { name: dana });
  await send(bob, game.id, { type: 'CallJudge', reason: 'slow-play', note: 'Carol has gone' });
  const call = (await view(alice, game.id)).judgeCalls?.[0];
  await api(`${judge}:judge`, 'POST', `/games/${game.id}/commands`, {
    commandId: `escalate-${Date.now()}`,
    command: {
      type: 'ResolveJudgeCall',
      id: call?.id,
      ruling: { kind: 'escalate' },
      note: 'Please find someone for Carol',
    },
  });
  const carolSeat = (await view(alice, game.id)).seats.find((s) => s.occupant === carol)?.id ?? '';

  const a = await signedIn(browser, `${admin}:admin`);
  await a.goto('/admin');
  const entry = a.getByRole('listitem').filter({ hasText: game.name });
  await expect(entry).toContainText('Please find someone for Carol');
  await entry.getByLabel('Seat').selectOption(carolSeat);
  await entry.getByLabel('New player').fill(dana);
  await entry.getByRole('button', { name: 'Replace' }).click();
  await expect(a.getByRole('listitem').filter({ hasText: game.name })).toHaveCount(0);
  expect((await view(alice, game.id)).seats.find((s) => s.id === carolSeat)?.occupant).toBe(dana);
});
