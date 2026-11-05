/**
 * The end of a game (GAME-08/09): the final standings once it's over, for everyone watching; and
 * the ways to end one early: an admin ends it, or the players of a casual game agree to.
 */
import type { GameState } from '@torn-signpost/engine';
import type { PlayerCommand } from '@torn-signpost/protocol';
import { useState } from 'react';

const REASONS = {
  'last-standing': 'Last Methuselah standing',
  'no-survivors': 'Nobody left standing',
  'time-limit': 'Time is up',
  admin: 'Ended by an admin',
  agreement: 'Ended by agreement',
} as const;

const vp = (n: number) => (Number.isInteger(n) ? String(n) : `${Math.floor(n) || ''}½`);

export function GameOver({
  view,
  seatName,
}: {
  view: GameState;
  seatName: (seat: string) => string;
}) {
  const r = view.result;
  if (view.status !== 'finished' || !r) return null;
  const standings = [...view.seats].sort((a, b) => b.vp - a.vp);
  return (
    <section className="game-over" aria-label="Game over">
      <h2>Game over</h2>
      <p>
        {REASONS[r.reason]} ·{' '}
        {r.winner ? (
          <strong>
            {seatName(r.winner)} wins{r.gameWin ? ' (a game win)' : ''}
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
          {standings.map((s) => (
            <tr key={s.id} className={s.id === r.winner ? 'winner' : undefined}>
              <th scope="row">{seatName(s.id)}</th>
              <td>{vp(s.vp)}</td>
              <td className="muted">
                {s.disqualified
                  ? 'disqualified'
                  : s.ousted
                    ? 'ousted'
                    : s.withdrawn
                      ? 'withdrew'
                      : 'still in'}
              </td>
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
