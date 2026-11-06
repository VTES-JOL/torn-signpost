/**
 * A finished game's result on its own (docs/m6-plan.md M6.6): a counted game's is public, even a
 * private one's (S1, F2), while its table stays with its players.
 */
import type { GameSummary } from '@torn-signpost/protocol';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, useApi } from '../api.ts';
import { ResultPanel } from '../game/GameEnd.tsx';

export function GameResultPage() {
  const { id = '' } = useParams();
  return <GameResult id={id} />;
}

/** The result of game `id`; `fallback` is shown instead if there's none to see. */
export function GameResult({ id, fallback }: { id: string; fallback?: string }) {
  const api = useApi();
  const [game, setGame] = useState<GameSummary | null>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api<GameSummary>(`/games/${id}/result`).then(setGame, (e) => {
      setGame(null);
      setError(e instanceof ApiError ? e.message : String(e));
    });
  }, [api, id]);
  if (game === undefined) return <p className="muted">Loading…</p>;
  if (!game?.ended) return <p className="notice">{fallback ?? error}</p>;
  return (
    <section>
      <h1>{game.name}</h1>
      <p className="muted small">
        {game.format} · {game.visibility} · ended{' '}
        {new Date(game.ended.at).toLocaleDateString(undefined, { dateStyle: 'medium' })} ·{' '}
        <Link to="/games">Games</Link>
      </p>
      <ResultPanel ending={game.ended} label="Result" />
    </section>
  );
}
