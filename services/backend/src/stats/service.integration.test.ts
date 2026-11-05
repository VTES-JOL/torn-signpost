import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { evolve, newGame, seededRng } from '@torn-signpost/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Identity } from '../auth.ts';
import { DeckStore } from '../db/decks.ts';
import { ProfileStore } from '../db/profiles.ts';
import { StatsStore } from '../db/stats.ts';
import type { GameStore } from '../db/store.ts';
import { GameService } from '../games/service.ts';
import type { ConnectionGateway } from '../realtime/gateway.ts';
import { Fanout } from '../realtime/realtime.ts';
import { testContent, testDeck } from '../testing/content.ts';
import { dynamoAvailable, testStore } from '../testing/dynamo.ts';
import { MIN_LEADERBOARD_GAMES, ResultsService } from './service.ts';

const available = await dynamoAvailable();

const user = (sub: string, groups: string[] = []): Identity => ({
  kind: 'user',
  sub,
  name: sub,
  groups,
});
const ada = user('ada', ['admin']);
const gateway: ConnectionGateway = { post: async () => true };

let n = 0;
let run = 0;

describe.skipIf(!available)('results and stats (DynamoDB Local)', () => {
  let store: GameStore;
  let db: DynamoDBDocumentClient;
  let tableName: string;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ store, db, tableName, cleanup } = await testStore()));
  afterAll(() => cleanup?.());

  function setup() {
    const stats = new StatsStore(db, tableName);
    const results = new ResultsService({
      store: stats,
      games: store,
      profiles: new ProfileStore(db, tableName),
      decks: new DeckStore(db, tableName),
      content: testContent,
    });
    const games = new GameService({
      store,
      content: testContent,
      rng: seededRng(++run),
      publisher: new Fanout(store, gateway),
      newId: () => `s${++n}`,
      results,
    });
    return { games, results, stats };
  }

  /** Players unique to one test, so tests don't share stats. */
  const players = (count: number) => {
    const tag = `t${++run}`;
    return Array.from({ length: count }, (_, i) => user(`${tag}p${i + 1}`));
  };

  async function finishedGame(
    games: GameService,
    who: Identity[],
    opts: { visibility?: 'public' | 'private'; vp?: { seatOf: Identity; delta: number } } = {},
  ) {
    const [host] = who as [Identity];
    const g = await games.create(host, {
      name: `Game ${++n}`,
      format: 'standard',
      visibility: opts.visibility ?? 'public',
      maxSeats: who.length,
    });
    for (const p of who) await games.join(p, g.id, { deck: testDeck });
    await games.start(host, g.id);
    if (opts.vp) {
      const d = await games.details(host, g.id);
      const seat = d.view?.seats.find(
        (s) => opts.vp?.seatOf.kind === 'user' && s.occupant === opts.vp.seatOf.sub,
      )?.id;
      await games.command(user('jo', ['judge']), g.id, {
        commandId: `vp-${++n}`,
        command: { type: 'AdjustVp', seat: seat ?? '', delta: opts.vp.delta },
      });
    }
    await games.command(ada, g.id, { commandId: `end-${++n}`, command: { type: 'EndGame' } });
    return g.id;
  }

  const sub = (p: Identity) => (p.kind === 'user' ? p.sub : '');

  it('records a counted game once, even when recorded again, and nothing for one that does not count', async () => {
    const { games, results, stats } = setup();
    const five = players(5);
    const id = await finishedGame(games, five, { vp: { seatOf: five[1] as Identity, delta: 2 } });
    const r = await stats.result(id);
    expect(r).toMatchObject({ players: 5, reason: 'admin', season: '2026' });
    expect(r?.seats.find((s) => s.user === sub(five[1] as Identity))).toMatchObject({
      vp: 2.5,
      gameWin: true,
      clans: ['Toreador'],
    });

    // The rebuild's path, run again on the same game: no double counting.
    const meta = await store.getMeta(id);
    const state = (await store.events(id, 0)).reduce(evolve, newGame(id));
    expect(await results.record(meta as NonNullable<typeof meta>, state)).toBe(true);
    const all = await stats.stats(sub(five[1] as Identity), 'all');
    expect(all).toMatchObject({ games: 1, gameWins: 1, vp: 2.5, wins: 1 });
    expect(all.byFormat.standard?.games).toBe(1);

    const four = players(4);
    const casual4 = await finishedGame(games, four);
    expect(await stats.result(casual4)).toBeUndefined();
    expect((await stats.stats(sub(four[0] as Identity), 'all')).games).toBe(0);
  });

  it('shows a private 5-player game in everyone’s view of a player’s history', async () => {
    const { games, results } = setup();
    const five = players(5);
    const id = await finishedGame(games, five, { visibility: 'private' });
    const history = await results.history(sub(five[2] as Identity));
    expect(history.items).toEqual([
      expect.objectContaining({ gameId: id, vp: 0.5, finish: 'in', replaced: false }),
    ]);
    // A private deck isn't shown (S5).
    expect(history.items[0]?.deck).toBeUndefined();
    const profile = await results.profile(sub(five[2] as Identity));
    expect(profile.stats.all.games).toBe(1);
    expect(profile.clans).toEqual([{ clan: 'Toreador', games: 1 }]);
  });

  it('gives a replacement the game in their games list, and credits them; the replaced get a game played', async () => {
    const { games, stats } = setup();
    const five = players(5);
    const [host] = five as [Identity];
    const newcomer = user(`${sub(host)}-new`);
    const g = await games.create(host, {
      name: 'Replaced',
      format: 'standard',
      visibility: 'public',
      maxSeats: 5,
    });
    for (const p of five) await games.join(p, g.id, { deck: testDeck });
    await games.start(host, g.id);
    const d = await games.details(host, g.id);
    const seat = d.view?.seats.find((s) => s.occupant === sub(five[4] as Identity))?.id ?? '';
    await games.command(ada, g.id, {
      commandId: `rep-${++n}`,
      command: { type: 'ReplacePlayer', seat, user: sub(newcomer) },
    });
    expect((await store.listUserGames(sub(newcomer))).map((m) => m.id)).toContain(g.id);
    await games.command(ada, g.id, { commandId: `end-${++n}`, command: { type: 'EndGame' } });
    expect(await stats.stats(sub(newcomer), 'all')).toMatchObject({ games: 1, vp: 0.5 });
    expect(await stats.stats(sub(five[4] as Identity), 'all')).toMatchObject({
      games: 1,
      replaced: 1,
      vp: 0,
    });
  });

  it('a rebuild from the event logs gives the same results, stats and history', async () => {
    const { games, results, stats } = setup();
    const five = players(5);
    const id = await finishedGame(games, five, { vp: { seatOf: five[0] as Identity, delta: 1 } });
    const who = sub(five[0] as Identity);
    const snapshot = async () => ({
      result: await stats.result(id),
      all: await stats.stats(who, 'all'),
      season: await stats.stats(who, '2026'),
      history: await stats.history(who),
    });
    const before = await snapshot();
    expect(await stats.clear()).toBeGreaterThan(0);
    expect((await stats.stats(who, 'all')).games).toBe(0);
    const meta = await store.getMeta(id);
    const state = (await store.events(id, 0)).reduce(evolve, newGame(id));
    await results.record(meta as NonNullable<typeof meta>, state);
    expect(await snapshot()).toEqual(before);
  });

  it('ranks players with enough games that season: game wins, then VP', {
    timeout: 60_000,
  }, async () => {
    const { games, results } = setup();
    const five = players(5);
    const [first] = five as [Identity];
    // The first player wins every game with 2.5 VP; the others have ½ VP each time.
    for (let i = 0; i < MIN_LEADERBOARD_GAMES; i++) {
      await finishedGame(games, five, { vp: { seatOf: first, delta: 2 } });
    }
    const board = await results.leaderboard({ season: '2026' });
    const mine = board.entries.filter((e) => five.some((p) => sub(p) === e.key));
    expect(mine).toHaveLength(5);
    expect(mine[0]).toMatchObject({ key: sub(first), stats: { gameWins: 5, vp: 12.5 } });
    expect(mine[0]?.winRate).toBe(1);
    expect(mine.slice(1).every((e) => e.stats.vp === 2.5 && e.stats.gameWins === 0)).toBe(true);

    // Fewer games than the minimum: not on the board (a fresh service, past the cache).
    const few = players(5);
    await finishedGame(games, few);
    const fresh = setup().results;
    const later = await fresh.leaderboard({ season: '2026' });
    expect(later.entries.some((e) => e.key === sub(few[0] as Identity))).toBe(false);
  });
});
