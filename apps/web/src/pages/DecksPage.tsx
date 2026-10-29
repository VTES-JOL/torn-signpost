import type { DeckSummary } from '@torn-signpost/protocol';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';

/** Your decks, and public decks anyone can browse (DECK-03). */
export function DecksPage() {
  const api = useApi();
  const { user } = useAuth();
  const [tab, setTab] = useState<'mine' | 'public'>(user ? 'mine' : 'public');
  const [format, setFormat] = useState('standard');
  const [decks, setDecks] = useState<DeckSummary[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setDecks(undefined);
    setError(undefined);
    const path = tab === 'mine' ? '/decks' : `/decks/public?format=${format}`;
    api<DeckSummary[]>(path).then(
      (d) => !cancelled && setDecks(d),
      (e) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [api, tab, format]);

  return (
    <section>
      <div className="toolbar">
        <h1>Decks</h1>
        {user && (
          <Link className="button" to="/decks/new">
            New deck
          </Link>
        )}
      </div>
      <div className="tabs" role="tablist">
        {user && (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'mine'}
            onClick={() => setTab('mine')}
          >
            My decks
          </button>
        )}
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'public'}
          onClick={() => setTab('public')}
        >
          Public decks
        </button>
        {tab === 'public' && (
          <select aria-label="Format" value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="standard">Standard</option>
            <option value="v5">V5</option>
            <option value="duel">Duel</option>
          </select>
        )}
      </div>
      {!user && <p className="muted">Sign in to build and save your own decks.</p>}
      {error && <p className="notice">{error}</p>}
      {!decks && !error && <p className="muted">Loading…</p>}
      {decks?.length === 0 && (
        <p className="muted">{tab === 'mine' ? 'No decks yet.' : 'No public decks yet.'}</p>
      )}
      <ul className="deck-list">
        {decks?.map((d) => (
          <li key={d.id}>
            <Link to={`/decks/${d.id}`}>{d.name}</Link>
            <span className="muted">
              {d.format} · {d.cryptCount} crypt · {d.libraryCount} library
              {tab === 'public' && ` · by ${d.ownerName}`}
            </span>
            <span className={d.legal ? 'badge ok' : 'badge'}>
              {d.legal ? 'Legal' : 'Not legal'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
