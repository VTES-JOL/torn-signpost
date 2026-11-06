import { expand } from '@torn-signpost/cards';
import {
  type Actor,
  type Command,
  decide,
  evolve,
  type GameState,
  newGame,
  seededRng,
} from '@torn-signpost/engine';
import { describe, expect, it } from 'vitest';
import type { GameMeta } from '../db/store.ts';
import { testContent, testDeck } from '../testing/content.ts';
import { counts, ending, gameResult, mainClans, statDeltas } from './result.ts';

const { catalog, index } = await testContent();
const rng = seededRng(5);
const at = '2026-11-05T10:00:00.000Z';
const admin: Actor = { kind: 'admin', user: 'ada' };

function apply(s: GameState, cmd: Command, actor: Actor): GameState {
  const r = decide(s, cmd, { actor, now: at, rng, catalog });
  if (!r.ok) throw new Error(r.rejection.message);
  return r.events.reduce(evolve, s);
}

const users = ['u1', 'u2', 'u3', 'u4', 'u5'];
function game(n: number, opts: { tournament?: boolean; decks?: (typeof testDeck)[] } = {}) {
  const seats = users.slice(0, n).map((user, i) => ({
    id: String(i + 1),
    user,
    ...expand(opts.decks?.[i] ?? testDeck),
  }));
  const s = apply(
    newGame('g'),
    {
      type: 'StartGame',
      gameId: 'g',
      format: 'standard',
      seats,
      ...(opts.tournament ? { settings: { tournament: true } } : {}),
    },
    { kind: 'system' },
  );
  const meta = {
    id: 'g',
    name: 'Table',
    format: 'standard',
    visibility: 'private',
    maxSeats: n,
    status: 'finished',
    players: seats.map((x) => ({
      user: x.user,
      name: x.user,
      deckRef: { id: `d-${x.user}`, version: 1 },
    })),
    createdBy: 'u1',
    createdAt: at,
    seq: 0,
    engineVersion: 'test',
  } as GameMeta;
  return { s, meta };
}

describe('which games count (docs/m6-plan.md M6.3)', () => {
  it('casual games of 5 players and tournament games, finished', () => {
    const end = (g: ReturnType<typeof game>) => apply(g.s, { type: 'EndGame' }, admin);
    expect(counts(end(game(5)))).toBe(true);
    expect(counts(end(game(4)))).toBe(false);
    expect(counts(end(game(3)))).toBe(false);
    expect(counts(end(game(4, { tournament: true })))).toBe(true);
    expect(counts(game(5).s)).toBe(false);
  });
});

describe('the result', () => {
  it('credits whoever finished the seat, and gives the one they replaced a "replaced" game', () => {
    const { s, meta } = game(5);
    let st = apply(s, { type: 'AdjustVp', seat: '2', delta: 2 }, { kind: 'judge', user: 'jo' });
    st = apply(st, { type: 'ReplacePlayer', seat: '3', user: 'u9' }, admin);
    st = apply(st, { type: 'EndGame' }, admin);
    const r = gameResult({ meta, state: st, startedAt: at, index });
    expect(r).toMatchObject({
      reason: 'admin',
      winner: '2',
      gameWin: '2',
      players: 5,
      season: '2026',
    });
    expect(r?.seats.find((x) => x.seat === '3')).toMatchObject({
      user: 'u9',
      replaced: ['u3'],
      vp: 0.5,
      finish: 'in',
      deck: { id: 'd-u3', version: 1 },
      clans: ['Toreador'],
    });
    const d = statDeltas(r as NonNullable<typeof r>);
    expect(d.get('u2')).toEqual({ games: 1, replaced: 0, gameWins: 1, vp: 2.5, wins: 1 });
    expect(d.get('u3')).toEqual({ games: 1, replaced: 1, gameWins: 0, vp: 0, wins: 0 });
    expect(d.get('u9')).toMatchObject({ games: 1, vp: 0.5 });
  });

  it('records nothing for a game that does not count', () => {
    const { s, meta } = game(4);
    const st = apply(s, { type: 'EndGame' }, admin);
    expect(gameResult({ meta, state: st, startedAt: at, index })).toBeUndefined();
  });
});

describe('main clans', () => {
  it('is the most common clan in the crypt, every one of them on a tie', () => {
    const mixed = {
      crypt: [
        { id: 't-tomas', count: 6 },
        { id: 't-ilse', count: 6 },
      ],
      library: testDeck.library,
    };
    const { s } = game(5, { decks: [mixed] });
    expect(mainClans(s, '1', index)).toEqual(['Brujah', 'Tremere']);
    expect(mainClans(s, '2', index)).toEqual(['Toreador']);
  });
});

describe('the ending kept on the meta (docs/m6-plan.md M6.6)', () => {
  it('has the standings, most VP first, with names, and whether the game counts', () => {
    const { s, meta } = game(4);
    expect(ending(meta, s)).toBeUndefined();
    let st = apply(s, { type: 'AdjustVp', seat: '3', delta: 2 }, { kind: 'judge', user: 'jo' });
    st = apply(st, { type: 'EndGame' }, admin);
    const e = ending(meta, st);
    expect(e).toMatchObject({ at, reason: 'admin', winner: '3', gameWin: true, counted: false });
    expect(e?.standings[0]).toEqual({ seat: '3', user: 'u3', name: 'u3', vp: 2.5, finish: 'in' });
    expect(e?.standings).toHaveLength(4);
  });

  it('has no winner when nobody has the most VP alone', () => {
    const { s, meta } = game(5);
    const e = ending(meta, apply(s, { type: 'EndGame' }, admin));
    expect(e?.winner).toBeUndefined();
    expect(e?.gameWin).toBeUndefined();
    expect(e?.counted).toBe(true);
  });
});
