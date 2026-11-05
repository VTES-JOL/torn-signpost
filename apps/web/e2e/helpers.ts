/**
 * Helpers for end-to-end tests: set games up through the API (fast, and not what's under test),
 * then drive the parts under test in real browsers, one context per player.
 */
import { randomUUID } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import {
  type Command,
  type GameState,
  prey,
  seatRefs,
  waitingOn,
  zoneId,
} from '@torn-signpost/engine';

export const API = 'http://localhost:3101';

/** A legal deck of the invented test cards. */
export const DECK = {
  crypt: [{ id: 't-vera', count: 12 }],
  library: [
    { id: 't-feed', count: 40 },
    { id: 't-ward', count: 20 },
  ],
};

/** User names unique to this run, so runs never share players, games or judge calls. */
export function users<const T extends string[]>(...names: T): { [K in keyof T]: string } {
  const run = randomUUID().slice(0, 6);
  return names.map((n) => `${n}-${run}`) as { [K in keyof T]: string };
}

export async function api<T = unknown>(
  user: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer dev:${user}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} as ${user}: ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** A started game with these players (the first creates it), each with the test deck. */
export async function startGame(
  players: string[],
  opts: { timeLimitMinutes?: number } = {},
): Promise<{ id: string; name: string }> {
  const [host = ''] = players;
  const name = `E2E ${randomUUID().slice(0, 8)}`;
  const game = await api<{ id: string }>(host, 'POST', '/games', {
    name,
    format: 'standard',
    visibility: 'public',
    maxSeats: players.length,
    ...opts,
  });
  for (const p of players) await api(p, 'POST', `/games/${game.id}/join`, { deck: DECK });
  await api(host, 'POST', `/games/${game.id}/start`);
  return { id: game.id, name };
}

export async function view(user: string, gameId: string): Promise<GameState> {
  return (await api<{ view: GameState }>(user, 'GET', `/games/${gameId}`)).view;
}

export async function send(user: string, gameId: string, command: Command): Promise<void> {
  await api(user, 'POST', `/games/${gameId}/commands`, {
    commandId: `e2e-${randomUUID()}`,
    command,
  });
}

/** The player sitting in `seat`. */
export function occupant(state: GameState, seat: string | undefined): string {
  const s = state.seats.find((x) => x.id === seat);
  if (!s?.occupant) throw new Error(`Nobody in seat ${seat}`);
  return s.occupant;
}

/** A page signed in as `user` (local dev tokens: `user` or `user:judge`). */
export async function signedIn(browser: Browser, user: string): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript((token) => {
    // about:blank has no storage; the app's own pages do.
    if (location.origin === 'null') return;
    localStorage.setItem('ts.auth', JSON.stringify({ idToken: token, expiresAt: 4102444800000 }));
  }, `dev:${user}`);
  return context.newPage();
}

/**
 * Give the acting player and their prey a ready minion each, and move on to the acting player's
 * minion phase, passing any windows on the way.
 */
export async function toMinionPhase(
  gameId: string,
  host: string,
): Promise<{ actor: string; prey: string }> {
  const start = await view(host, gameId);
  const actorSeat = start.turn?.seat;
  const preySeat = actorSeat && prey(seatRefs(start), actorSeat);
  if (!actorSeat || !preySeat) throw new Error('No turn');
  for (const seat of [actorSeat, preySeat]) {
    const user = occupant(start, seat);
    const mine = await view(user, gameId);
    const card = mine.zones[zoneId(seat, 'uncontrolled')]?.[0];
    if (!card) throw new Error(`No uncontrolled minion for ${seat}`);
    await send(user, gameId, { type: 'MoveCard', card, to: zoneId(seat, 'ready') });
  }
  for (let i = 0; i < 20; i++) {
    const s = await view(host, gameId);
    if (s.turn?.phase === 'minion' && !s.window) break;
    const wait = waitingOn(s)[0];
    if (!wait) throw new Error('Nobody to wait on');
    await send(occupant(s, wait.seat), gameId, {
      type: wait.kind === 'phase' ? 'AdvancePhase' : 'Pass',
    });
  }
  return { actor: occupant(start, actorSeat), prey: occupant(start, preySeat) };
}
