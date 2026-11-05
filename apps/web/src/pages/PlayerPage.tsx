/** A player's page (STATS-02): stats, favourite decks and clans, and their counted games. */
import type {
  HistoryEntry,
  HistoryResponse,
  PlayerProfile,
  PlayerStats,
} from '@torn-signpost/protocol';
import { winRate } from '@torn-signpost/protocol';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, useApi } from '../api.ts';
import { percent, vp } from '../stats/format.ts';

const FINISH = {
  in: 'still in',
  ousted: 'ousted',
  withdrew: 'withdrew',
  disqualified: 'disqualified',
};

export function PlayerPage() {
  const { key = '' } = useParams();
  const api = useApi();
  const [profile, setProfile] = useState<PlayerProfile>();
  const [games, setGames] = useState<HistoryEntry[]>([]);
  const [next, setNext] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setProfile(undefined);
    setError(undefined);
    const path = encodeURIComponent(key);
    Promise.all([
      api<PlayerProfile>(`/users/${path}`),
      api<HistoryResponse>(`/users/${path}/games`),
    ]).then(
      ([p, h]) => {
        setProfile(p);
        setGames(h.items);
        setNext(h.next);
      },
      (e) => setError(e instanceof ApiError ? e.message : String(e)),
    );
  }, [api, key]);
  if (error) return <p className="notice">{error}</p>;
  if (!profile) return <p className="muted">Loading…</p>;
  const more = async () => {
    if (!next) return;
    const h = await api<HistoryResponse>(
      `/users/${encodeURIComponent(key)}/games?before=${encodeURIComponent(next)}`,
    );
    setGames((g) => [...g, ...h.items]);
    setNext(h.next);
  };
  return (
    <section className="player-page">
      <h1>{profile.name}</h1>
      <p className="muted small">Results count casual games of 5 players and tournament games.</p>
      <div className="stat-cards">
        <StatCard title={`Season ${profile.season}`} stats={profile.stats.season} />
        <StatCard title="All time" stats={profile.stats.all} />
      </div>
      {profile.clans.length > 0 && (
        <p>
          <strong>Clans:</strong> {profile.clans.map((c) => `${c.clan} (${c.games})`).join(', ')}
        </p>
      )}
      {profile.decks.length > 0 && (
        <p>
          <strong>Decks:</strong>{' '}
          {profile.decks.map((d, i) => (
            <span key={d.id}>
              {i > 0 && ', '}
              <Link to={`/decks/${d.id}`}>{d.name}</Link> ({d.games})
            </span>
          ))}
        </p>
      )}
      <h2>Games</h2>
      {games.length === 0 ? (
        <p className="muted">No counted games yet.</p>
      ) : (
        <table className="stats-table">
          <thead>
            <tr>
              <th scope="col">Game</th>
              <th scope="col">Ended</th>
              <th scope="col">VP</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {games.map((g) => (
              <tr key={g.gameId}>
                <th scope="row">
                  <Link to={`/games/${g.gameId}`}>{g.name}</Link>
                  {g.tournament && <span className="badge">Tournament</span>}
                </th>
                <td>{new Date(g.endedAt).toLocaleDateString()}</td>
                <td>{g.replaced ? '–' : vp(g.vp)}</td>
                <td>
                  {g.replaced ? 'replaced' : `${g.gameWin ? 'game win · ' : ''}${FINISH[g.finish]}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next && (
        <button type="button" onClick={() => void more()}>
          Older
        </button>
      )}
    </section>
  );
}

function StatCard({ title, stats }: { title: string; stats: PlayerStats }) {
  return (
    <section className="stat-card" aria-label={title}>
      <h2>{title}</h2>
      <dl>
        <dt>Games</dt>
        <dd>{stats.games}</dd>
        <dt>Game wins</dt>
        <dd>{stats.gameWins}</dd>
        <dt>VP</dt>
        <dd>{vp(stats.vp)}</dd>
        <dt>Win rate</dt>
        <dd>{percent(winRate(stats))}</dd>
      </dl>
    </section>
  );
}
