/**
 * The judge queue (GAME-18): every open judge call across games, oldest first, so judges can share
 * the load. Claim a call here, or open the table to rule on it.
 */
import type { JudgeQueueEntry } from '@torn-signpost/protocol';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { formatLeft } from '../game/Clock.tsx';
import { REASON_LABELS } from '../game/JudgeCalls.tsx';

/** How often the queue refreshes; new calls also show up as notifications later (M5b.5). */
const REFRESH_MS = 15_000;

export function JudgePage() {
  const api = useApi();
  const { user } = useAuth();
  const [entries, setEntries] = useState<JudgeQueueEntry[]>();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const judge = !!user?.groups.includes('judge');

  const load = useCallback(async () => {
    try {
      setEntries(await api<JudgeQueueEntry[]>('/judge/calls'));
      setNow(Date.now());
      setError(undefined);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    if (!judge) return;
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [judge, load]);

  if (!judge) return <p className="notice">The judge queue is for judges.</p>;

  const claim = async (e: JudgeQueueEntry) => {
    try {
      await api(`/games/${e.gameId}/commands`, {
        method: 'POST',
        body: {
          commandId: `claim-${e.call.id}-${Date.now()}`,
          command: { type: 'ClaimJudgeCall', id: e.call.id },
        },
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const shown = (entries ?? []).filter((e) => !reason || e.call.reason === reason);
  return (
    <section>
      <h1>Judge queue</h1>
      <p className="muted">
        Open judge calls in every game, oldest first. Claim one so other judges know it's taken.
      </p>
      {error && <p className="notice">{error}</p>}
      <div className="toolbar">
        <select aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">Every reason</option>
          {Object.entries(REASON_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {!entries && <p className="muted">Loading…</p>}
      {entries && shown.length === 0 && <p className="muted">No open calls.</p>}
      <ul className="deck-list judge-queue">
        {shown.map((e) => (
          <li key={`${e.gameId}-${e.call.id}`}>
            <Link to={`/games/${e.gameId}`}>{e.gameName}</Link>
            <span className="badge">{REASON_LABELS[e.call.reason]}</span>
            {e.tournament && <span className="badge">Tournament</span>}
            <span className="muted">
              {e.call.by ? `seat ${e.call.by} called` : 'the game called'}
              {e.call.seat ? ` about seat ${e.call.seat}` : ''} ·{' '}
              {e.call.note ? `“${e.call.note}” · ` : ''}
              waiting {formatLeft(now - Date.parse(e.call.openedAt))} ·{' '}
              {e.call.claimedBy
                ? e.call.claimedBy === user?.sub
                  ? 'yours'
                  : `claimed by ${e.call.claimedBy}`
                : 'unclaimed'}
            </span>
            {!e.call.claimedBy && (
              <button type="button" onClick={() => void claim(e)}>
                Claim
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
