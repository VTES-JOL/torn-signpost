/**
 * Archon, against the fake Archon: linking a player's account from the account page (docs/m7-plan.md
 * M7.1), and an organiser linking a tournament they run (M7.2), each through Archon's consent and
 * back; a player registering with a deck, checking in and dropping out (M7.3).
 */
import { expect, test } from '@playwright/test';
import { api, DECK, signedIn, users } from './helpers.ts';

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
  await expect(page.getByRole('link', { name: 'Your account' })).toBeVisible();
});

test('a tournament admin links a tournament they run in Archon, and follows its rounds', async ({
  browser,
}) => {
  const [olga, zed] = users('olga', 'zed');
  const org = await fake<{ uid: string }>('members', { name: `Org ${olga}`, vekn_id: '3200200' });
  const players = await Promise.all(
    [1, 2, 3, 4].map((i) =>
      fake<{ uid: string }>('members', { name: `Player ${i} ${olga}`, vekn_id: `320021${i}` }),
    ),
  );
  const t = await fake<{ uid: string }>('tournaments', {
    organizer: org.uid,
    tournament: { name: `Cup ${olga}`, start: '2030-06-01T09:00:00Z' },
  });
  const act = (action: unknown) => fake('act', { tournament: t.uid, action });
  await act({ type: 'OpenRegistration' });
  for (const p of players) await act({ type: 'Register', user_uid: p.uid });
  await fake('sign-in', { uid: org.uid });

  // Linking tournaments is for tournament admins.
  const page = await signedIn(browser, `${olga}:tournament_admin`);
  await page.goto('/tournaments');
  await page.getByLabel('The tournament in Archon').fill(`${ARCHON}/tournaments/${t.uid}`);
  await page.getByRole('button', { name: 'Link in Archon…' }).click();
  await expect(page).toHaveURL(new RegExp(`/tournaments/${t.uid}\\?linked=1$`));
  await expect(page.getByRole('heading', { name: `Cup ${olga}`, level: 1 })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Linked');
  const roster = page.getByRole('region', { name: 'Players' });
  await expect(roster.getByRole('row')).toHaveCount(5);
  await expect(roster).toContainText('3200211');

  // Archon draws a round; the organiser reads it now rather than waiting for the next poll.
  await act({ type: 'CloseRegistration' });
  await act({ type: 'CheckInAll' });
  await act({ type: 'StartRound' });
  await page.getByRole('button', { name: 'Read from Archon now' }).click();
  const table = page.getByRole('region', { name: 'Round 1, table 1' });
  await expect(table).toContainText('In Progress');
  await expect(table.getByRole('listitem')).toHaveCount(4);

  // Anyone signed in sees it in the list and its rounds, without the organiser's tools.
  const other = await signedIn(browser, zed);
  await other.goto('/tournaments');
  await other.getByRole('link', { name: `Cup ${olga}` }).click();
  await expect(other.getByRole('region', { name: 'Round 1, table 1' })).toBeVisible();
  await expect(other.getByRole('button', { name: 'Read from Archon now' })).toHaveCount(0);
  await other.goto('/tournaments');
  await expect(other.getByRole('region', { name: 'Link a tournament' })).toHaveCount(0);
});

/** Through Archon's consent without a browser: `user` approves as `member` (signed in there). */
async function consent(user: string, member: string, start: string, body?: unknown) {
  await fake('sign-in', { uid: member });
  const { url } = await api<{ url: string }>(user, 'POST', start, body);
  const res = await fetch(url, { redirect: 'manual' });
  const back = Object.fromEntries(new URL(res.headers.get('location') ?? '').searchParams);
  return api(user, 'POST', '/archon/callback', back);
}

test('a player registers with a deck, checks in and drops out; the organiser sees it', async ({
  browser,
}) => {
  const [olga, pia] = users('olga', 'pia');
  const org = await fake<{ uid: string }>('members', { name: `Org ${olga}`, vekn_id: '3200300' });
  const t = await fake<{ uid: string }>('tournaments', {
    organizer: org.uid,
    tournament: { name: `Open ${olga}`, start: '2030-07-01T09:00:00Z' },
  });
  const act = (action: unknown) => fake('act', { tournament: t.uid, action });
  await act({ type: 'OpenRegistration' });
  const admin = `${olga}:tournament_admin`;
  await consent(admin, org.uid, '/tournaments/link', { archon: t.uid });

  // Pia has an Archon account with a VEKN number, linked here, and a legal deck.
  const member = await fake<{ uid: string }>('members', { name: `Pia ${pia}`, vekn_id: '3200301' });
  await consent(pia, member.uid, '/me/archon/link');
  await api(pia, 'POST', '/decks', {
    name: 'Vera Bleed',
    format: 'standard',
    visibility: 'private',
    cards: DECK,
  });

  const page = await signedIn(browser, pia);
  await page.goto(`/tournaments/${t.uid}`);
  const entry = page.getByRole('region', { name: 'Your registration' });
  await expect(entry.getByLabel('Deck')).toContainText('Vera Bleed');
  await entry.getByRole('button', { name: 'Register', exact: true }).click();
  await expect(entry).toContainText('You’re registered with Vera Bleed (version 1)');
  await expect(entry).toContainText('Registered');
  const roster = page.getByRole('region', { name: 'Players' });
  await expect(roster).toContainText(`Pia ${pia}`);

  // The organiser closes registration in Archon, opening check-in, and reads it here (or the next
  // poll would); she checks in.
  await act({ type: 'CloseRegistration' });
  await api(admin, 'POST', `/tournaments/${t.uid}/refresh`);
  await page.reload();
  await entry.getByRole('button', { name: 'Check in for the next round' }).click();
  await expect(entry).toContainText('Checked-in');

  // Archon received her, her deck and her check-in, sent with the organiser's grant.
  const log = await (await fetch(`${ARCHON}/_fake/log`, { method: 'POST' })).json();
  expect(
    (log as { tournament: string; action: { type: string } }[])
      .filter((l) => l.tournament === t.uid)
      .map((l) => l.action.type),
  ).toEqual(['OpenRegistration', 'AddPlayer', 'UpsertDeck', 'CloseRegistration', 'CheckIn']);

  // The organiser sees who's registered here.
  const orgPage = await signedIn(browser, admin);
  await orgPage.goto(`/tournaments/${t.uid}`);
  const row = orgPage.getByRole('region', { name: 'Players' }).getByRole('row', { name: /Pia/ });
  await expect(row).toContainText('Checked-in');
  await expect(row).not.toContainText('No deck');

  // Dropping out after registration closed: still in Archon's list, finished.
  await entry.getByRole('button', { name: 'Drop out…' }).click();
  await entry.getByRole('button', { name: 'Drop out', exact: true }).click();
  await expect(entry).toContainText('You dropped out of this tournament.');
});
