/**
 * Linking an Archon account (docs/m7-plan.md M7.1), against the fake Archon: from the account
 * page to Archon's consent and back, then unlinking.
 */
import { expect, test } from '@playwright/test';
import { signedIn, users } from './helpers.ts';

const ARCHON = 'http://localhost:3103';

// The fake Archon has one signed-in member, like one browser: its tests take turns.
test.describe.configure({ mode: 'serial' });

async function fake<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${ARCHON}/_fake/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

test('a player links their Archon account, sees their VEKN number, and unlinks it', async ({
  browser,
}) => {
  const [ana] = users('ana');
  const member = await fake<{ uid: string }>('members', {
    name: `Archon ${ana}`,
    vekn_id: '3200123',
  });
  // As if signed in to Archon: they approve the consent.
  await fake('sign-in', { uid: member.uid });
  const page = await signedIn(browser, ana);
  await page.goto('/account');
  const section = page.getByRole('region', { name: 'Archon account' });
  await section.getByRole('button', { name: 'Link your Archon account' }).click();

  // Off to Archon and straight back (the fake approves), then to the account page.
  await expect(page).toHaveURL(/\/account\?archon=linked$/);
  await expect(section.getByRole('status')).toHaveText('Your Archon account is linked.');
  await expect(section).toContainText('VEKN number 3200123');

  await section.getByRole('button', { name: 'Unlink…' }).click();
  await section.getByRole('button', { name: 'Unlink', exact: true }).click();
  await expect(section.getByRole('button', { name: 'Link your Archon account' })).toBeVisible();
});

test('declining in Archon links nothing, and says so', async ({ browser }) => {
  const [ben] = users('ben');
  await fake('sign-in', { uid: null });
  const page = await signedIn(browser, ben);
  await page.goto('/account');
  await page
    .getByRole('region', { name: 'Archon account' })
    .getByRole('button', { name: 'Link your Archon account' })
    .click();
  await expect(page.getByText('Archon didn’t approve the link')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to your account' })).toBeVisible();
});
