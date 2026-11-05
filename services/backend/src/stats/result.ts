/**
 * The result of a finished game (STATS-01, docs/m6-plan.md M6.3): pure, from the game's meta and
 * final state, so the live path and the rebuild agree.
 */
import type { CardIndex } from '@torn-signpost/cards';
import { clockElapsed, type GameState } from '@torn-signpost/engine';
import type { Finish, GameResultRecord, SeatResult, StatLine } from '@torn-signpost/protocol';
import type { GameMeta } from '../db/store.ts';

/** Casual games of 5 players and tournament games of any size count; nothing else does. */
export function counts(state: GameState): boolean {
  return state.status === 'finished' && (state.settings.tournament || state.seats.length === 5);
}

/** The most common clans among `seat`'s crypt cards; several on a tie, none without data. */
export function mainClans(state: GameState, seat: string, index: CardIndex): string[] {
  const tally = new Map<string, number>();
  for (const c of Object.values(state.cards)) {
    if (c.owner !== seat || !c.cardId) continue;
    const card = index.byId.get(c.cardId);
    if (card?.kind !== 'crypt') continue;
    for (const clan of card.clans ?? []) tally.set(clan, (tally.get(clan) ?? 0) + 1);
  }
  const top = Math.max(0, ...tally.values());
  return top
    ? [...tally]
        .filter(([, n]) => n === top)
        .map(([c]) => c)
        .sort()
    : [];
}

export function gameResult(input: {
  meta: GameMeta;
  state: GameState;
  startedAt: string;
  index: CardIndex;
}): GameResultRecord | undefined {
  const { meta, state, startedAt, index } = input;
  const r = state.result;
  if (!counts(state) || !r) return undefined;
  const finish = (s: GameState['seats'][number]): Finish =>
    s.disqualified ? 'disqualified' : s.ousted ? 'ousted' : s.withdrawn ? 'withdrew' : 'in';
  const seats = state.seats.map((s): SeatResult => {
    const deck = meta.players.find((p) => p.user === s.occupants[0]?.user)?.deckRef;
    return {
      seat: s.id,
      user: s.occupant,
      replaced: s.occupants.filter((o) => o.user !== s.occupant).map((o) => o.user),
      vp: s.vp,
      gameWin: r.gameWin === s.id,
      finish: finish(s),
      ...(deck ? { deck } : {}),
      clans: mainClans(state, s.id, index),
    };
  });
  const played = state.settings.timeLimitMs !== undefined ? clockElapsed(state, r.at) : undefined;
  return {
    gameId: meta.id,
    name: meta.name,
    format: meta.format,
    tournament: state.settings.tournament,
    players: state.seats.length,
    reason: r.reason,
    ...(r.winner ? { winner: r.winner } : {}),
    ...(r.gameWin ? { gameWin: r.gameWin } : {}),
    startedAt,
    endedAt: r.at,
    ...(played !== undefined ? { playedMs: played } : {}),
    season: r.at.slice(0, 4),
    seats,
  };
}

/** What a result adds to each player's stats: the finisher's result, and "replaced" for the rest. */
export function statDeltas(result: GameResultRecord): Map<string, StatLine> {
  const out = new Map<string, StatLine>();
  for (const s of result.seats) {
    out.set(s.user, {
      games: 1,
      replaced: 0,
      gameWins: s.gameWin ? 1 : 0,
      vp: s.vp,
      wins: result.winner === s.seat ? 1 : 0,
    });
    for (const u of s.replaced) {
      out.set(u, { games: 1, replaced: 1, gameWins: 0, vp: 0, wins: 0 });
    }
  }
  return out;
}
