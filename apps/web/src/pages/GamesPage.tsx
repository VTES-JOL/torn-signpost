/** Game lobby (LOBBY-01/02): open and running public games, your games, and creating one. */
import type { CreateGameRequest, GameSummary } from '@torn-signpost/protocol';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';

export function GamesPage() {
  const api = useApi();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [lists, setLists] = useState<Record<string, GameSummary[] | undefined>>({});
  const [error, setError] = useState<string>();
  const [form, setForm] = useState<CreateGameRequest>({
    name: '',
    format: 'standard',
    visibility: 'public',
    maxSeats: 5,
  });

  useEffect(() => {
    const load = (key: string) =>
      api<GameSummary[]>(`/games?status=${key}`).then(
        (games) => setLists((l) => ({ ...l, [key]: games })),
        (e) => setError(e instanceof ApiError ? e.message : String(e)),
      );
    void load('open');
    void load('active');
    if (user) void load('mine');
  }, [api, user]);

  const create = async () => {
    try {
      const game = await api<GameSummary>('/games', { method: 'POST', body: form });
      navigate(`/games/${game.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const list = (title: string, games: GameSummary[] | undefined, empty: string) => (
    <div>
      <h2>{title}</h2>
      {!games && <p className="muted">Loading…</p>}
      {games?.length === 0 && <p className="muted">{empty}</p>}
      <ul className="deck-list">
        {games?.map((g) => (
          <li key={g.id}>
            <Link to={`/games/${g.id}`}>{g.name}</Link>
            <span className="muted">
              {g.format} · {g.players.length}/{g.maxSeats} · {g.status} ·{' '}
              {g.players.map((p) => p.name).join(', ')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <section>
      <h1>Games</h1>
      {error && <p className="notice">{error}</p>}
      {user ? (
        <form
          className="toolbar create-game"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input
            aria-label="Game name"
            placeholder="Game name"
            required
            maxLength={60}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <select
            aria-label="Format"
            value={form.format}
            onChange={(e) => {
              const format = e.target.value as CreateGameRequest['format'];
              setForm({
                ...form,
                format,
                maxSeats: format === 'duel' ? 2 : Math.max(3, form.maxSeats),
              });
            }}
          >
            <option value="standard">Standard</option>
            <option value="v5">V5</option>
            <option value="duel">Duel</option>
          </select>
          {form.format !== 'duel' && (
            <select
              aria-label="Seats"
              value={form.maxSeats}
              onChange={(e) => setForm({ ...form, maxSeats: Number(e.target.value) })}
            >
              <option value={5}>5 players</option>
              <option value={4}>4 players</option>
              <option value={3}>3 players</option>
            </select>
          )}
          <select
            aria-label="Visibility"
            value={form.visibility}
            onChange={(e) =>
              setForm({ ...form, visibility: e.target.value as CreateGameRequest['visibility'] })
            }
          >
            <option value="public">Public</option>
            <option value="private">Invite only</option>
          </select>
          <button type="submit" className="primary">
            Create game
          </button>
        </form>
      ) : (
        <p className="muted">Sign in to create or join games. Anyone can watch public games.</p>
      )}
      {user && list('Your games', lists.mine, 'You are not in any games.')}
      {list('Open games', lists.open, 'No open games right now.')}
      {list('Games in progress', lists.active, 'No public games in progress.')}
    </section>
  );
}
