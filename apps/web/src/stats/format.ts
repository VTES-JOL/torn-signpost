/** Shared formatting for results and stats (STATS-01..03). */
import type { GameState } from '@torn-signpost/engine';

/** 2, 2½, ½. */
export const vp = (n: number) => (Number.isInteger(n) ? String(n) : `${Math.floor(n) || ''}½`);

export const percent = (n: number | undefined) =>
  n === undefined ? '–' : `${Math.round(n * 100)}%`;

/** Casual games of 5 players and tournament games have results (docs/m6-plan.md M6.3). */
export const counted = (view: GameState) => view.settings.tournament || view.seats.length === 5;
