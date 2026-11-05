/** Withdrawal (GAME-09): offered only when allowed, confirmed, shown to the table, taking effect. */

import { expect, type Page, test } from '@playwright/test';
import { waitingOn, zoneId } from '@torn-signpost/engine';
import { occupant, send, signedIn, startGame, users, view } from './helpers.ts';

const flow = (page: Page) => page.getByRole('region', { name: 'Game flow' });

test('a player with an empty library withdraws, and leaves at the start of their next turn', async ({
  browser,
}) => {
  const [alice, bob, carol] = users('alice', 'bob', 'carol');
  const game = await startGame([alice, bob, carol]);
  const start = await view(alice, game.id);
  const seat = start.turn?.seat ?? '';
  const player = occupant(start, seat);
  const other = [alice, bob, carol].find((u) => u !== player) ?? '';
  const p = await signedIn(browser, player);
  const o = await signedIn(browser, other);
  await p.goto(`/games/${game.id}`);
  await o.goto(`/games/${game.id}`);
  await expect(flow(p)).toContainText('Your decision: Your unlock phase');
  // A full library: no sign of it.
  await expect(flow(p).getByRole('button', { name: 'Withdraw…' })).toHaveCount(0);

  // Run the library out, and discard down to 6.
  const mine = await view(player, game.id);
  await send(player, game.id, {
    type: 'Draw',
    seat,
    count: mine.zones[zoneId(seat, 'library')]?.length ?? 0,
  });
  const hand = (await view(player, game.id)).zones[zoneId(seat, 'hand')] ?? [];
  for (const card of hand.slice(6)) {
    await send(player, game.id, { type: 'MoveCard', card, to: zoneId(seat, 'ashHeap') });
  }

  await flow(p).getByRole('button', { name: 'Withdraw…' }).click();
  await expect(flow(p)).toContainText(
    'You’ll leave the game at the start of your next turn, with ½ VP',
  );
  await flow(p).getByRole('button', { name: 'Confirm' }).click();
  const badge = o
    .getByRole('region', { name: new RegExp(`Seat ${seat}:`) })
    .getByText('withdrawing');
  await expect(badge).toBeVisible();
  await expect(flow(p).getByRole('button', { name: 'Withdraw…' })).toHaveCount(0);

  // Round the table, passing every window on the way, back to the withdrawing seat.
  for (let i = 0; i < 40; i++) {
    const s = await view(alice, game.id);
    if (s.seats.find((x) => x.id === seat)?.withdrawn) break;
    const wait = waitingOn(s)[0];
    if (!wait) break;
    await send(occupant(s, wait.seat), game.id, {
      type: wait.kind === 'phase' ? 'AdvancePhase' : 'Pass',
    });
  }
  await expect(p.getByText('You withdrew from the game.')).toBeVisible();
  const after = await view(alice, game.id);
  expect(after.seats.find((x) => x.id === seat)).toMatchObject({ withdrawn: true, vp: 0.5 });
  expect(after.turn?.seat).not.toBe(seat);
});
