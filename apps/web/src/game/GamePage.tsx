/** A game: the pre-game lobby room, then the table with log, chat and console (M4). */

import { createCatalog } from '@torn-signpost/engine';
import type { DeckSummary } from '@torn-signpost/protocol';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { Link, useParams } from 'react-router';
import { ApiError, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { useCards, useConfig } from '../content.tsx';
import { ConsolePanel } from './ConsolePanel.tsx';
import { GameClient, type GameSnapshot } from './client.ts';
import { LogPanel } from './LogPanel.tsx';
import { Table } from './Table.tsx';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function GamePage() {
  const { id = '' } = useParams();
  const api = useApi();
  const auth = useAuth();
  const { wsUrl } = useConfig();
  const cards = useCards();
  const catalog = useMemo(
    () => (cards.state === 'ready' ? createCatalog(cards.index.cards) : undefined),
    [cards],
  );

  // Recreate the client (and its connection) only when the game or the signed-in user changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: api/auth identities change on every token refresh
  const client = useMemo(() => {
    if (!catalog) return undefined;
    return new GameClient({
      gameId: id,
      api,
      wsUrl,
      token: () => auth.token(),
      catalog,
      ...(auth.user ? { user: auth.user } : {}),
      // Animate other players' moves with a view transition (UX-08), unless motion is reduced.
      animate: (apply) => {
        const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
        if (doc.startViewTransition && !reducedMotion())
          doc.startViewTransition(() => flushSync(apply));
        else apply();
      },
    });
  }, [id, wsUrl, catalog, auth.user?.sub]);

  useEffect(() => {
    if (!client) return;
    void client.start();
    return () => client.stop();
  }, [client]);

  if (cards.state === 'error') return <p className="notice">{cards.error}</p>;
  if (!client || !catalog) return <p className="muted">Loading cards…</p>;
  return <GameView client={client} catalog={catalog} />;
}

function GameView({
  client,
  catalog,
}: {
  client: GameClient;
  catalog: ReturnType<typeof createCatalog>;
}) {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const auth = useAuth();
  const [error, setError] = useState<string>();
  const [panel, setPanel] = useState<'log' | 'console'>('log');
  const [showConsole, setShowConsole] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === '`' &&
        !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        setShowConsole((v) => !v);
        setPanel('console');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(undefined), 5000);
    return () => clearTimeout(t);
  }, [error]);

  if (snapshot.status === 'loading') return <p className="muted">Loading game…</p>;
  if (snapshot.status === 'error') return <p className="notice">{snapshot.error}</p>;
  const game = snapshot.game;
  if (!game) return null;
  if (game.status === 'open') return <LobbyRoom client={client} snapshot={snapshot} />;

  const judge = auth.user?.groups.includes('judge') ?? false;
  const canChat = !!snapshot.seat || judge;
  return (
    <section className="game">
      <div className="toolbar game-title">
        <h1>{game.name}</h1>
        <span className="muted small">
          {game.format} ·{' '}
          {snapshot.seat ? `you are seat ${snapshot.seat}` : judge ? 'judging' : 'spectating'}
          {snapshot.status === 'reconnecting' && ' · reconnecting…'}
        </span>
        <button
          type="button"
          aria-pressed={showConsole}
          onClick={() => {
            setShowConsole((v) => !v);
            setPanel('console');
          }}
        >
          Console (`)
        </button>
      </div>
      {error && (
        <p className="toast" role="alert">
          {error}
        </p>
      )}
      <div className="game-layout">
        <div className="game-table">
          <Table client={client} snapshot={snapshot} judge={judge} onError={setError} />
        </div>
        <aside className="game-side">
          <div className="tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={panel === 'log'}
              onClick={() => setPanel('log')}
            >
              Log & chat
            </button>
            {(showConsole || panel === 'console') && (
              <button
                type="button"
                role="tab"
                aria-selected={panel === 'console'}
                onClick={() => setPanel('console')}
              >
                Console
              </button>
            )}
          </div>
          {panel === 'console' && showConsole ? (
            <ConsolePanel client={client} snapshot={snapshot} catalog={catalog} />
          ) : (
            <LogPanel client={client} snapshot={snapshot} canChat={canChat} me={auth.user?.name} />
          )}
        </aside>
      </div>
    </section>
  );
}

/** Before the game starts: who's in, pick a deck, join or leave, start (LOBBY-02). */
function LobbyRoom({ client, snapshot }: { client: GameClient; snapshot: GameSnapshot }) {
  const api = useApi();
  const auth = useAuth();
  const game = snapshot.game;
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [deckId, setDeckId] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!auth.user) return;
    api<DeckSummary[]>('/decks').then(setDecks, () => setDecks([]));
  }, [api, auth.user]);
  if (!game) return null;
  const joined = game.players.some((p) => p.user === auth.user?.sub);
  const usable = decks.filter(
    (d) =>
      d.legal && (d.format === game.format || (game.format === 'duel' && d.format === 'standard')),
  );
  const min = game.format === 'duel' ? 2 : 3;
  const act = async (action: 'join' | 'leave' | 'start', body?: unknown) => {
    setBusy(true);
    setError(undefined);
    try {
      await client.lobby(action, body);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="lobby-room">
      <h1>{game.name}</h1>
      <p className="muted">
        {game.format} · {game.visibility} · {game.players.length}/{game.maxSeats} players · waiting
        to start
      </p>
      <ul>
        {game.players.map((p) => (
          <li key={p.user}>
            {p.name}
            {p.user === game.createdBy && <span className="muted small"> (host)</span>}
          </li>
        ))}
      </ul>
      {!auth.user && <p className="muted">Sign in to join this game.</p>}
      {auth.user && !joined && (
        <div className="toolbar">
          <select aria-label="Deck" value={deckId} onChange={(e) => setDeckId(e.target.value)}>
            <option value="">Choose a deck…</option>
            {usable.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="primary"
            disabled={!deckId || busy}
            onClick={() => void act('join', { deckId })}
          >
            Join
          </button>
          {usable.length === 0 && (
            <span className="muted small">
              You need a legal {game.format} deck — <Link to="/decks/new">build one</Link>.
            </span>
          )}
        </div>
      )}
      {joined && (
        <div className="toolbar">
          <button type="button" disabled={busy} onClick={() => void act('leave')}>
            Leave
          </button>
          {game.createdBy === auth.user?.sub && (
            <button
              type="button"
              className="primary"
              disabled={busy || game.players.length < min}
              onClick={() => void act('start')}
            >
              Start game
            </button>
          )}
          {game.players.length < min && (
            <span className="muted small">Needs at least {min} players.</span>
          )}
        </div>
      )}
      <p className="muted small">Share this page's address to invite players.</p>
      {error && <p className="notice">{error}</p>}
    </section>
  );
}
