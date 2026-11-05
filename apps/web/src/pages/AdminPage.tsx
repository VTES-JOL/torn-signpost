/**
 * The admin queue (GAME-19): casual games a judge referred to the admins, usually because a player
 * has gone. Replace the seat's player with someone willing (by display name), or dismiss it.
 */
import type { Escalation, GameDetails } from '@torn-signpost/protocol';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { REASON_LABELS } from '../game/JudgeCalls.tsx';

export function AdminPage() {
  const api = useApi();
  const { user } = useAuth();
  const admin = !!user?.groups.includes('admin');
  const [entries, setEntries] = useState<Escalation[]>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      setEntries(await api<Escalation[]>('/admin/escalations'));
      setError(undefined);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [api]);
  useEffect(() => {
    if (admin) void load();
  }, [admin, load]);
  if (!admin) return <p className="notice">The admin queue is for admins.</p>;
  return (
    <section>
      <h1>Admin queue</h1>
      <p className="muted">
        Casual games a judge referred to the admins, oldest first. Replace a player who has gone
        with someone willing to take over their seat, or dismiss the referral.
      </p>
      {error && <p className="notice">{error}</p>}
      {!entries && <p className="muted">Loading…</p>}
      {entries?.length === 0 && <p className="muted">Nothing waiting.</p>}
      <ul className="deck-list judge-queue">
        {entries?.map((e) => (
          <EscalationItem key={`${e.gameId}-${e.call.id}`} entry={e} onDone={() => void load()} />
        ))}
      </ul>
    </section>
  );
}

function EscalationItem({ entry, onDone }: { entry: Escalation; onDone: () => void }) {
  const api = useApi();
  const [details, setDetails] = useState<GameDetails>();
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    api<GameDetails>(`/games/${entry.gameId}`).then(setDetails, () => {});
  }, [api, entry.gameId]);
  const seats = (details?.view?.seats ?? []).filter((s) => !s.ousted && !s.withdrawn);
  const resolve = async (body: unknown) => {
    try {
      await api(`/admin/escalations/${entry.gameId}/${entry.call.id}`, { method: 'POST', body });
      onDone();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <li>
      <Link to={`/games/${entry.gameId}`}>{entry.gameName}</Link>
      <span className="badge">{REASON_LABELS[entry.call.reason]}</span>
      <span className="muted">
        {entry.call.seat ? `about seat ${entry.call.seat} · ` : ''}
        {entry.note ? `the judge said “${entry.note}” · ` : ''}
        {new Date(entry.at).toLocaleString()}
      </span>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          void resolve({
            replace: { seat: String(data.get('seat')), name: String(data.get('name')).trim() },
          });
        }}
      >
        <select name="seat" aria-label="Seat" defaultValue={entry.call.seat ?? seats[0]?.id}>
          {seats.map((s) => (
            <option key={s.id} value={s.id}>
              Seat {s.id}
            </option>
          ))}
        </select>
        <input name="name" aria-label="New player" placeholder="New player's name" required />
        <button type="submit" className="primary">
          Replace
        </button>
        <button type="button" onClick={() => void resolve({ dismiss: true })}>
          Dismiss
        </button>
      </form>
      {message && (
        <p className="notice small" role="status">
          {message}
        </p>
      )}
    </li>
  );
}
