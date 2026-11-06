/**
 * The end of a game (GAME-08/09): the final standings once it's over, for everyone watching; and
 * the ways to end one early: an admin ends it, or the players of a casual game agree to.
 */
import type { GameState } from '@torn-signpost/engine';
import type { Finish, GameEnding, PlayerCommand } from '@torn-signpost/protocol';
import { useState } from 'react';
import { Link } from 'react-router';
import { useConfig } from '../content.tsx';
import { counted, vp } from '../stats/format.ts';

export const REASONS = {
  'last-standing': 'Last Methuselah standing',
  'no-survivors': 'Nobody left standing',
  'time-limit': 'Time is up',
  admin: 'Ended by an admin',
  agreement: 'Ended by agreement',
} as const;

const FINISHED: Record<Finish, string> = {
  in: 'still in',
  ousted: 'ousted',
  withdrew: 'withdrew',
  disqualified: 'disqualified',
};

/** The live table's Game over panel, for everyone watching it (GAME-16). */
export function GameOver({
  view,
  seatName,
}: {
  view: GameState;
  seatName: (seat: string) => string;
}) {
  const ending = endingOf(view, seatName);
  return ending ? <ResultPanel ending={ending} /> : null;
}

/** The ending as the server records it (`GameSummary.ended`), from the table's own view. */
export function endingOf(
  view: GameState,
  seatName: (seat: string) => string,
): GameEnding | undefined {
  const r = view.result;
  if (view.status !== 'finished' || !r) return undefined;
  return {
    at: r.at,
    reason: r.reason,
    ...(r.winner ? { winner: r.winner, gameWin: r.gameWin === r.winner } : {}),
    counted: counted(view),
    standings: view.seats
      .map((s) => ({
        seat: s.id,
        user: s.occupant,
        name: seatName(s.id),
        vp: s.vp,
        finish: (s.disqualified
          ? 'disqualified'
          : s.ousted
            ? 'ousted'
            : s.withdrawn
              ? 'withdrew'
              : 'in') as Finish,
      }))
      .sort((a, b) => b.vp - a.vp),
  };
}

/** One line for lists of games: the winner, or why nobody won. */
export function endingLine(e: GameEnding): string {
  const winner = e.standings.find((s) => s.seat === e.winner);
  return winner
    ? `${winner.name} won${e.gameWin ? ' (a game win)' : ''}`
    : `${REASONS[e.reason]}: nobody won`;
}

/** The final standings: on the table, and on a game's result page. */
export function ResultPanel({
  ending: e,
  label = 'Game over',
}: {
  ending: GameEnding;
  label?: string;
}) {
  const stats = !!useConfig().flags.stats;
  // Counted games have results on each player's page (docs/m6-plan.md M6.3).
  const linked = stats && e.counted;
  const winner = e.standings.find((s) => s.seat === e.winner);
  return (
    <section className="game-over" aria-label={label}>
      <h2>{label}</h2>
      <p>
        {REASONS[e.reason]} ·{' '}
        {winner ? (
          <strong>
            {winner.name} wins{e.gameWin ? ' (a game win)' : ''}
          </strong>
        ) : (
          'nobody wins'
        )}
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Methuselah</th>
            <th scope="col">VP</th>
            <th scope="col">Finished</th>
          </tr>
        </thead>
        <tbody>
          {e.standings.map((s) => (
            <tr key={s.seat} className={s.seat === e.winner ? 'winner' : undefined}>
              <th scope="row">
                {linked ? (
                  <Link to={`/players/${encodeURIComponent(s.user)}`}>{s.name}</Link>
                ) : (
                  s.name
                )}
              </th>
              <td>{vp(s.vp)}</td>
              <td className="muted">{FINISHED[s.finish]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Ending early: an admin, or (casual games) every player still in agreeing. */
export function EndGameControls({
  view,
  seat,
  admin,
  seatName,
  send,
}: {
  view: GameState;
  seat: string | undefined;
  admin: boolean;
  seatName: (seat: string) => string;
  send: (command: PlayerCommand) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (view.status !== 'active') return null;
  const p = view.endProposal;
  const live = view.seats.filter((s) => !s.ousted && !s.withdrawn);
  const inGame = seat !== undefined && live.some((s) => s.id === seat);
  const casual = !view.settings.tournament;
  if (!p && !admin && !(inGame && casual)) return null;
  return (
    <section className="end-game toolbar" aria-label="End the game">
      {p && (
        <span role="status">
          {seatName(p.by)} proposes ending the game, scored as a timeout. Agreed:{' '}
          {p.agreed.map(seatName).join(', ')}; waiting for{' '}
          {live
            .filter((s) => !p.agreed.includes(s.id))
            .map((s) => seatName(s.id))
            .join(', ')}
          .
        </span>
      )}
      {p && inGame && !p.agreed.includes(seat) && (
        <>
          <button type="button" className="primary" onClick={() => send({ type: 'AgreeEnd' })}>
            Agree
          </button>
          <button type="button" onClick={() => send({ type: 'DeclineEnd' })}>
            Play on
          </button>
        </>
      )}
      {!p && inGame && casual && (
        <button type="button" onClick={() => send({ type: 'ProposeEnd' })}>
          Propose ending the game
        </button>
      )}
      {admin &&
        (confirming ? (
          <>
            <span>End the game now? Everyone still in it gains ½ VP.</span>
            <button
              type="button"
              className="primary"
              onClick={() => {
                send({ type: 'EndGame' });
                setConfirming(false);
              }}
            >
              End the game
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirming(true)}>
            End the game…
          </button>
        ))}
    </section>
  );
}
