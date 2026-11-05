/**
 * Results, stats, history and leaderboards (STATS-01..03, docs/m6-plan.md M6.3). Only counted games
 * (casual games of 5 players, tournament games) have them; their results are public.
 */
import type { GameState } from '@torn-signpost/engine';
import type {
  GameFormat,
  HistoryEntry,
  HistoryResponse,
  Leaderboard,
  LeaderboardEntry,
  PlayerProfile,
  StatLine,
} from '@torn-signpost/protocol';
import { winRate } from '@torn-signpost/protocol';
import type { Content } from '../content/catalog.ts';
import type { DeckStore } from '../db/decks.ts';
import type { ProfileStore } from '../db/profiles.ts';
import type { StatsStore } from '../db/stats.ts';
import type { GameMeta, GameStore } from '../db/store.ts';
import { ApiError } from '../errors.ts';
import { gameResult, statDeltas } from './result.ts';

/** Counted games a player needs in a season to appear on its leaderboard (S2). */
export const MIN_LEADERBOARD_GAMES = 5;
const PAGE = 20;
const BOARD_CACHE_MS = 2 * 60_000;

export class ResultsService {
  private readonly now: () => Date;
  private readonly boards = new Map<string, { at: number; board: Leaderboard }>();

  constructor(
    private readonly deps: {
      store: StatsStore;
      games: GameStore;
      profiles: ProfileStore;
      decks: DeckStore;
      content: Content;
      now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  /** A game just ended: record it if it counts. Logged, not thrown: the game has ended anyway. */
  async gameEnded(meta: GameMeta, state: GameState): Promise<void> {
    try {
      await this.record(meta, state);
    } catch (e) {
      console.error('recording the result failed', { gameId: meta.id, error: String(e) });
    }
  }

  /** A player brought in by a replacement: the game is theirs too (their games list). */
  async joined(user: string, gameId: string): Promise<void> {
    await this.deps.store.putMembership(user, gameId);
  }

  /** Record a finished game's result (the live path and the rebuild). False if it doesn't count. */
  async record(meta: GameMeta, state: GameState): Promise<boolean> {
    const [first] = await this.deps.games.events(meta.id, 0, 1);
    const { index } = await this.deps.content();
    const result = gameResult({ meta, state, startedAt: first?.at ?? meta.createdAt, index });
    if (!result) return false;
    const history = new Map<string, HistoryEntry>();
    for (const s of result.seats) {
      const entry = (replaced: boolean): HistoryEntry => ({
        gameId: result.gameId,
        name: result.name,
        format: result.format,
        tournament: result.tournament,
        endedAt: result.endedAt,
        seat: s.seat,
        vp: replaced ? 0 : s.vp,
        gameWin: !replaced && s.gameWin,
        finish: s.finish,
        replaced,
        ...(s.deck ? { deck: s.deck } : {}),
        clans: s.clans,
      });
      history.set(s.user, entry(false));
      for (const u of s.replaced) history.set(u, entry(true));
    }
    const names = new Map<string, { name: string; key: string }>();
    for (const user of history.keys()) {
      const chosen = (await this.deps.profiles.get(user))?.name;
      const joined = meta.players.find((p) => p.user === user)?.name;
      names.set(user, { name: chosen ?? joined ?? user, key: chosen ?? user });
    }
    await this.deps.store.record(result, statDeltas(result), history, names);
    return true;
  }

  async profile(key: string): Promise<PlayerProfile> {
    const sub = await this.subOf(key);
    const season = this.now().toISOString().slice(0, 4);
    const [seasonStats, all, history, profile, recorded] = await Promise.all([
      this.deps.store.stats(sub, season),
      this.deps.store.stats(sub, 'all'),
      this.deps.store.history(sub),
      this.deps.profiles.get(sub),
      this.deps.store.name(sub),
    ]);
    const deckGames = new Map<string, number>();
    const clanGames = new Map<string, number>();
    for (const h of history) {
      if (h.deck) deckGames.set(h.deck.id, (deckGames.get(h.deck.id) ?? 0) + 1);
      for (const c of h.clans) clanGames.set(c, (clanGames.get(c) ?? 0) + 1);
    }
    const decks: PlayerProfile['decks'] = [];
    for (const [id, games] of [...deckGames].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      const d = await this.deps.decks.get(id);
      if (d?.visibility === 'public') decks.push({ id, name: d.name, games });
    }
    return {
      key: profile?.name ?? sub,
      name: profile?.name ?? recorded ?? sub,
      season,
      stats: { season: seasonStats, all },
      decks: decks.slice(0, 5),
      clans: [...clanGames]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([clan, games]) => ({ clan, games })),
    };
  }

  /** A player's counted games, newest first; a deck only when it's public (S5). */
  async history(key: string, before?: string): Promise<HistoryResponse> {
    const sub = await this.subOf(key);
    const all = await this.deps.store.history(sub);
    const from = before ? all.findIndex((h) => h.gameId === before) + 1 : 0;
    const page = all.slice(from, from + PAGE);
    const items: HistoryEntry[] = [];
    for (const h of page) {
      const pub = h.deck && (await this.deps.decks.get(h.deck.id))?.visibility === 'public';
      const { deck, ...rest } = h;
      items.push(pub && deck ? { ...rest, deck } : rest);
    }
    const last = page.at(-1);
    return { items, ...(from + PAGE < all.length && last ? { next: last.gameId } : {}) };
  }

  async leaderboard(opts: {
    season?: string;
    format?: GameFormat;
    by?: Leaderboard['by'];
  }): Promise<Leaderboard> {
    const season = opts.season ?? this.now().toISOString().slice(0, 4);
    const by = opts.by ?? 'gw';
    const cacheKey = `${season}/${opts.format ?? ''}/${by}`;
    const hit = this.boards.get(cacheKey);
    if (hit && Date.now() - hit.at < BOARD_CACHE_MS) return hit.board;
    const rows = (await this.deps.store.season(season))
      .map((r) => {
        const line: StatLine | undefined = opts.format ? r.stats.byFormat[opts.format] : r.stats;
        return line ? { ...r, line } : undefined;
      })
      .filter((r): r is NonNullable<typeof r> => !!r && r.line.games >= MIN_LEADERBOARD_GAMES);
    const rate = (l: StatLine) => winRate(l) ?? 0;
    rows.sort((a, b) => {
      const primary =
        by === 'vp'
          ? b.line.vp - a.line.vp
          : by === 'winrate'
            ? rate(b.line) - rate(a.line)
            : b.line.gameWins - a.line.gameWins;
      return (
        primary ||
        b.line.gameWins - a.line.gameWins ||
        b.line.vp - a.line.vp ||
        a.line.games - b.line.games ||
        a.name.localeCompare(b.name)
      );
    });
    const entries = rows.map((r, i): LeaderboardEntry => {
      const w = winRate(r.line);
      return {
        rank: i + 1,
        key: r.key,
        name: r.name,
        stats: r.line,
        ...(w !== undefined ? { winRate: w } : {}),
      };
    });
    const board: Leaderboard = {
      season,
      ...(opts.format ? { format: opts.format } : {}),
      by,
      minGames: MIN_LEADERBOARD_GAMES,
      entries,
    };
    this.boards.set(cacheKey, { at: Date.now(), board });
    return board;
  }

  /** A display name, or the user's key for players without one. */
  private async subOf(key: string): Promise<string> {
    const byName = await this.deps.profiles.ownerOf(key);
    if (
      byName &&
      (await this.deps.profiles.get(byName))?.name.toLowerCase() === key.toLowerCase()
    ) {
      return byName;
    }
    if ((await this.deps.store.stats(key, 'all')).games > 0) return key;
    throw new ApiError(404, 'not_found', `Nobody is called “${key}”`);
  }
}
