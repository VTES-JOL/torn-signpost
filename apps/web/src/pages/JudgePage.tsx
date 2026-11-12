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

export interface QueueFilter {
  /** A `JudgeCall` reason, or '' for every reason. */
  reason: string;
  status: 'any' | 'unclaimed' | 'mine' | 'others';
  kind: 'any' | 'tournament' | 'casual';
}

export const ANY: QueueFilter = { reason: '', status: 'any', kind: 'any' };

/** The calls a judge asked to see; `me` is their user ID, for their own claims. */
export function filterQueue(
  entries: readonly JudgeQueueEntry[],
  f: QueueFilter,
  me: string | undefined,
): JudgeQueueEntry[] {
  return entries.filter((e) => {
    const by = e.call.claimedBy;
    if (f.reason && e.call.reason !== f.reason) return false;
    if (f.status === 'unclaimed' && by) return false;
    if (f.status === 'mine' && (!by || by !== me)) return false;
    if (f.status === 'others' && (!by || by === me)) return false;
    if (f.kind === 'tournament' && !e.tournament) return false;
    if (f.kind === 'casual' && e.tournament) return false;
    return true;
  });
}

export function JudgePage() {
  const api = useApi();
  const { user } = useAuth();
  const [entries, setEntries] = useState<JudgeQueueEntry[]>();
  const [filter, setFilter] = useState<QueueFilter>(ANY);
  const set = (patch: Partial<QueueFilter>) => setFilter((f) => ({ ...f, ...patch }));
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

  const shown = filterQueue(entries ?? [], filter, user?.sub);
  const filtered = shown.length < (entries?.length ?? 0);
  return (
    <section>
      <h1>Judge queue</h1>
      <p className="muted">
        Open judge calls in every game, oldest first. Claim one so other judges know it's taken.
      </p>
      {error && <p className="notice">{error}</p>}
      <div className="toolbar">
        <select
          aria-label="Reason"
          value={filter.reason}
          onChange={(e) => set({ reason: e.target.value })}
        >
          <option value="">Every reason</option>
          {Object.entries(REASON_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="Claimed"
          value={filter.status}
          onChange={(e) => set({ status: e.target.value as QueueFilter['status'] })}
        >
          <option value="any">Claimed or not</option>
          <option value="unclaimed">Unclaimed</option>
          <option value="mine">Claimed by me</option>
          <option value="others">Claimed by other judges</option>
        </select>
        <select
          aria-label="Game kind"
          value={filter.kind}
          onChange={(e) => set({ kind: e.target.value as QueueFilter['kind'] })}
        >
          <option value="any">Tournament or casual</option>
          <option value="tournament">Tournament games</option>
          <option value="casual">Casual games</option>
        </select>
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {!entries && <p className="muted">Loading…</p>}
      {entries && shown.length === 0 && (
        <p className="muted">
          {filtered ? (
            <>
              No open calls match.{' '}
              <button type="button" onClick={() => setFilter(ANY)}>
                Show every call
              </button>
            </>
          ) : (
            'No open calls.'
          )}
        </p>
      )}
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
