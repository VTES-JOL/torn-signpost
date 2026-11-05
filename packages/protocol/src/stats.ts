/**
 * Results and stats (STATS-01..03, docs/m6-plan.md M6.3). Only counted games have them: casual
 * games of 5 players, and tournament games. A counted game's result is public.
 */
import type { z } from 'zod';
import type { Format as FormatSchema } from './games.ts';

/** A game format: standard, v5 or duel. */
export type GameFormat = z.infer<typeof FormatSchema>;
type Format = GameFormat;

export type Finish = 'in' | 'ousted' | 'withdrew' | 'disqualified';
export type EndReason = 'last-standing' | 'no-survivors' | 'time-limit' | 'admin' | 'agreement';

export interface SeatResult {
  seat: string;
  /** The player who finished the seat, credited with its result (DQ8). */
  user: string;
  /** Players who held the seat before them: a game played, no GW or VP. */
  replaced: string[];
  vp: number;
  gameWin: boolean;
  finish: Finish;
  deck?: { id: string; version: number };
  /** The most common clans among the seat's crypt; ties list several. */
  clans: string[];
}

/** `GAME#<id> / RESULT`. */
export interface GameResultRecord {
  gameId: string;
  name: string;
  format: Format;
  tournament: boolean;
  players: number;
  reason: EndReason;
  winner?: string;
  gameWin?: string;
  startedAt: string;
  endedAt: string;
  /** Played time on the table timer, for timed games. */
  playedMs?: number;
  /** Calendar year of `endedAt`, UTC. */
  season: string;
  seats: SeatResult[];
}

export interface StatLine {
  games: number;
  /** Games in which the player was replaced: played, but no GW or VP, out of the win rate. */
  replaced: number;
  gameWins: number;
  vp: number;
  /** Games they won (the most VP alone), game win or not. */
  wins: number;
}

export interface PlayerStats extends StatLine {
  byFormat: Partial<Record<Format, StatLine>>;
}

/** Game wins ÷ games, leaving out replaced ones; undefined with none. */
export function winRate(s: StatLine): number | undefined {
  const n = s.games - s.replaced;
  return n > 0 ? s.gameWins / n : undefined;
}

export interface HistoryEntry {
  gameId: string;
  name: string;
  format: Format;
  tournament: boolean;
  endedAt: string;
  seat: string;
  vp: number;
  gameWin: boolean;
  finish: Finish;
  /** True when this player was replaced before the end. */
  replaced: boolean;
  /** Only when the deck is public (S5). */
  deck?: { id: string; version: number };
  clans: string[];
}

export interface PlayerProfile {
  /** The user's stable key, for links when they have no chosen name. */
  key: string;
  name: string;
  season: string;
  stats: { season: PlayerStats; all: PlayerStats };
  /** Public decks they played most, with counts. */
  decks: { id: string; name: string; games: number }[];
  /** Clans they played most, with counts. */
  clans: { clan: string; games: number }[];
}

export interface HistoryResponse {
  items: HistoryEntry[];
  next?: string;
}

export interface LeaderboardEntry {
  rank: number;
  key: string;
  name: string;
  stats: StatLine;
  winRate?: number;
}

export interface Leaderboard {
  season: string;
  format?: Format;
  by: 'gw' | 'vp' | 'winrate';
  /** Counted games a player needs that season to appear. */
  minGames: number;
  entries: LeaderboardEntry[];
}
