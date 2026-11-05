/** Leaderboards (STATS-03): one season, one format or all, ranked by game wins, VP or win rate. */
import type { Leaderboard } from '@torn-signpost/protocol';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, useApi } from '../api.ts';
import { percent, vp } from '../stats/format.ts';

const FIRST_SEASON = 2026;

export function LeaderboardsPage() {
  const api = useApi();
  const thisYear = new Date().getUTCFullYear();
  const [season, setSeason] = useState(String(thisYear));
  const [format, setFormat] = useState('');
  const [by, setBy] = useState<Leaderboard['by']>('gw');
  const [board, setBoard] = useState<Leaderboard>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const q = new URLSearchParams({ season, by, ...(format ? { format } : {}) });
    api<Leaderboard>(`/leaderboards?${q}`).then(setBoard, (e) =>
      setError(e instanceof ApiError ? e.message : String(e)),
    );
  }, [api, season, format, by]);
  const seasons = Array.from({ length: thisYear - FIRST_SEASON + 1 }, (_, i) =>
    String(thisYear - i),
  );
  return (
    <section>
      <h1>Leaderboards</h1>
      <div className="toolbar">
        <select aria-label="Season" value={season} onChange={(e) => setSeason(e.target.value)}>
          {seasons.map((s) => (
            <option key={s} value={s}>
              Season {s}
            </option>
          ))}
        </select>
        <select aria-label="Format" value={format} onChange={(e) => setFormat(e.target.value)}>
          <option value="">Every format</option>
          <option value="standard">Standard</option>
          <option value="v5">V5</option>
          <option value="duel">Duel</option>
        </select>
        <select
          aria-label="Ranked by"
          value={by}
          onChange={(e) => setBy(e.target.value as Leaderboard['by'])}
        >
          <option value="gw">Game wins</option>
          <option value="vp">Victory points</option>
          <option value="winrate">Win rate</option>
        </select>
      </div>
      {error && <p className="notice">{error}</p>}
      {board && (
        <>
          <p className="muted small">
            Players with at least {board.minGames} counted games this season: casual games of 5
            players, and tournament games.
          </p>
          {board.entries.length === 0 ? (
            <p className="muted">Nobody yet.</p>
          ) : (
            <table className="stats-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Player</th>
                  <th scope="col">Games</th>
                  <th scope="col">Game wins</th>
                  <th scope="col">VP</th>
                  <th scope="col">Win rate</th>
                </tr>
              </thead>
              <tbody>
                {board.entries.map((e) => (
                  <tr key={e.key}>
                    <td>{e.rank}</td>
                    <th scope="row">
                      <Link to={`/players/${encodeURIComponent(e.key)}`}>{e.name}</Link>
                    </th>
                    <td>{e.stats.games}</td>
                    <td>{e.stats.gameWins}</td>
                    <td>{vp(e.stats.vp)}</td>
                    <td>{percent(e.winRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
