/** Email settings and unsubscribe links (NOTIF-02). Locally, emails are printed, not sent. */
import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { EmailSettings } from '@torn-signpost/protocol';
import { api, signedIn, users } from './helpers.ts';

/** The local server's key for unsubscribe links (services/backend/src/local/server.ts). */
const sign = (u: string, c: string) =>
  createHmac('sha256', 'local-unsubscribe-secret')
    .update(`unsubscribe:${u}:${c}`)
    .digest('base64url');

test('email settings save, and a link from an email unsubscribes without signing in', async ({
  browser,
}) => {
  const [ana] = users('ana');
  const a = await signedIn(browser, ana);
  await a.goto('/account');
  await expect(a.getByText(`Sent to ${ana}@example.test`)).toBeVisible();
  const turn = a.getByLabel('Your turn');
  await expect(turn).toHaveValue('digest');
  await turn.selectOption('immediate');
  await expect(a.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await a.reload();
  await expect(a.getByLabel('Your turn')).toHaveValue('immediate');

  // The link in an email, opened by someone not signed in.
  const page = await browser.newPage();
  await page.goto(`/unsubscribe?u=${ana}&c=deadline&t=${sign(ana, 'deadline')}`);
  await expect(page.getByText('Stop deadline emails from Torn Signpost?')).toBeVisible();
  await page.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(page.getByRole('status')).toContainText('no more deadline emails');
  const after = await api<EmailSettings>(ana, 'GET', '/me/email');
  expect(after.prefs.modes).toMatchObject({
    deadline: 'off',
    turn: 'immediate',
    judge: 'immediate',
  });

  // A tampered link does nothing.
  await page.goto(`/unsubscribe?u=${ana}&c=all&t=${sign(ana, 'deadline')}`);
  await page.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(page.getByRole('status')).toContainText('That didn’t work');
  expect((await api<EmailSettings>(ana, 'GET', '/me/email')).prefs.modes.judge).toBe('immediate');
});
