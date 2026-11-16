/**
 * Tournaments (docs/m7-plan.md M7.2): run in Archon, the VEKN's tournament manager, and linked
 * here by their organisers. These pages show Archon's state as we last read it (every minute
 * while a tournament is under way); the tournament itself is managed in Archon. Players register
 * here, with a deck of theirs (M7.3).
 */
import type {
  ArchonLinkStart,
  DeckSummary,
  TournamentDetails,
  TournamentList,
  TournamentState,
  TournamentSummary,
} from '@torn-signpost/protocol';
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { vp } from '../stats/format.ts';

const message = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

const STATE: Record<TournamentState, { label: string; tone: string }> = {
  Planned: { label: 'Planned', tone: '' },
  Registration: { label: 'Registration open', tone: 'ok' },
  Waiting: { label: 'Between rounds', tone: 'attention' },
  Playing: { label: 'Round under way', tone: 'attention' },
  Finals: { label: 'Finals', tone: 'attention' },
  Finished: { label: 'Finished', tone: '' },
};

const underWay = (s: TournamentState) => s === 'Waiting' || s === 'Playing' || s === 'Finals';

/** A date in the tournament's own time zone, where Archon gives one. */
function when(iso: string | null, timeZone: string | null): string {
  if (!iso) return 'Date to be announced';
  const opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
  try {
    return new Date(iso).toLocaleString(undefined, { ...opts, ...(timeZone ? { timeZone } : {}) });
  } catch {
    return new Date(iso).toLocaleString(undefined, opts);
  }
}

function StateBadge({ state }: { state: TournamentState }) {
  const s = STATE[state] ?? { label: state, tone: '' };
  return <span className={`badge ${s.tone}`.trim()}>{s.label}</span>;
}

export function TournamentsPage() {
  const api = useApi();
  const { user } = useAuth();
  const [list, setList] = useState<TournamentSummary[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api<TournamentList>('/tournaments').then(
      (l) => setList(l.tournaments),
      (e) => setError(message(e)),
    );
  }, [api]);

  const running = list?.filter((t) => underWay(t.state));
  const upcoming = list
    ?.filter((t) => t.state === 'Planned' || t.state === 'Registration')
    .sort((a, b) => (a.start ?? '9').localeCompare(b.start ?? '9'));
  const finished = list?.filter((t) => t.state === 'Finished');

  const section = (title: string, items: TournamentSummary[] | undefined, empty: string) => (
    <div>
      <h2>{title}</h2>
      {!items && !error && <p className="muted">Loading…</p>}
      {items?.length === 0 && <p className="muted">{empty}</p>}
      <ul className="deck-list">
        {items?.map((t) => (
          <li key={t.id}>
            <Link to={`/tournaments/${t.id}`}>{t.name}</Link>
            <StateBadge state={t.state} />
            <span className="muted">
              {when(t.start, t.timezone)} · {t.online ? 'Online' : (t.place ?? 'In person')} ·{' '}
              {t.format} · {t.players} {t.players === 1 ? 'player' : 'players'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <section>
      <h1>Tournaments</h1>
      <p className="muted small">
        Tournaments are run with Archon, the VEKN’s tournament manager: the table draw, scores and
        standings are Archon’s. Their games are played here.
      </p>
      {error && <p className="notice">{error}</p>}
      {section('Under way', running, 'None right now.')}
      {section('Upcoming', upcoming, 'None announced yet.')}
      {section('Finished', finished, 'None yet.')}
      {/* Linking and managing tournaments is for tournament admins (docs/roles.md). */}
      {user?.groups.includes('tournament_admin') && <LinkTournament />}
      {!user && <p className="muted">Sign in to see players, rounds and standings.</p>}
    </section>
  );
}

/**
 * A tournament admin links a tournament they organise in Archon, by granting us `event:run` for
 * it there.
 */
function LinkTournament() {
  const api = useApi();
  const [archon, setArchon] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { url } = await api<ArchonLinkStart>('/tournaments/link', {
        method: 'POST',
        body: { archon },
      });
      window.location.assign(url);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };
  return (
    <section aria-label="Link a tournament">
      <h2>Link a tournament</h2>
      <p className="muted small">
        Organising a tournament in Archon? Link it to play its games here. Archon asks you to let
        Torn Signpost run it for you; you can withdraw that in Archon at any time.
      </p>
      <form className="toolbar link-tournament" onSubmit={(e) => void submit(e)}>
        <input
          aria-label="The tournament in Archon"
          placeholder="https://archon…/tournaments/…"
          value={archon}
          onChange={(e) => setArchon(e.target.value)}
          required
        />
        <button type="submit" className="primary" disabled={busy || !archon.trim()}>
          Link in Archon…
        </button>
      </form>
      {error && <p className="notice small">{error}</p>}
    </section>
  );
}

export function TournamentPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [t, setT] = useState<TournamentDetails>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const load = useCallback(
    () => api<TournamentDetails>(`/tournaments/${id}`).then(setT, (e) => setError(message(e))),
    [api, id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // Under way, follow it as the server does (it reads Archon every minute).
  const live = t ? underWay(t.state) : false;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [live, load]);

  const refresh = async () => {
    setBusy(true);
    try {
      setT(await api<TournamentDetails>(`/tournaments/${id}/refresh`, { method: 'POST' }));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const relink = async () => {
    if (!t) return;
    setBusy(true);
    try {
      const { url } = await api<ArchonLinkStart>('/tournaments/link', {
        method: 'POST',
        body: { archon: t.archonUrl },
      });
      window.location.assign(url);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  const unlink = async () => {
    setBusy(true);
    try {
      await api(`/tournaments/${id}`, { method: 'DELETE' });
      navigate('/tournaments', { replace: true });
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  if (error && !t) return <p className="notice">{error}</p>;
  if (!t) return <p className="muted">Loading…</p>;
  const latest = t.detail?.rounds.at(-1);
  return (
    <section className="tournament">
      <p className="small">
        <Link to="/tournaments">← Tournaments</Link>
      </p>
      <h1>{t.name}</h1>
      {params.get('linked') && t.manage && (
        <p className="notice small" role="status">
          Linked. Torn Signpost follows it from Archon now.
        </p>
      )}
      <p>
        <StateBadge state={t.state} /> {when(t.start, t.timezone)}
        {t.finish ? ` – ${when(t.finish, t.timezone)}` : ''}
      </p>
      <p className="muted">
        {t.online ? 'Online' : (t.place ?? 'In person')} · {t.format} · {t.players}{' '}
        {t.players === 1 ? 'player' : 'players'} · {t.maxRounds} rounds of {t.roundTime} minutes
        {t.multideck ? ' · a deck per round' : ''}
      </p>
      {t.winner && (
        <p>
          Winner: <strong>{t.winner}</strong>
        </p>
      )}
      {t.description && <p className="tournament-description">{t.description}</p>}
      <p className="muted small">
        Organised by {t.officials.length ? t.officials.join(', ') : t.organiser} · linked here by{' '}
        {t.organiser} · <a href={t.archonUrl}>See it in Archon</a> · updated{' '}
        {new Date(t.updatedAt).toLocaleTimeString(undefined, { timeStyle: 'short' })}
      </p>

      {t.manage && (
        <section className="notice small" aria-label="Organiser">
          {t.manage.grant === 'lost' ? (
            <p>
              <strong>Archon no longer accepts this link</strong> (it was withdrawn in Archon, or
              ran out). Link it again to keep following it.
            </p>
          ) : t.manage.lastError ? (
            <p>The last read from Archon failed: {t.manage.lastError}</p>
          ) : null}
          <p className="toolbar">
            {t.manage.grant === 'lost' ? (
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void relink()}
              >
                Link again in Archon…
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={() => void refresh()}>
                Read from Archon now
              </button>
            )}
            {confirming ? (
              <>
                <span>Stop following it here?</span>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => void unlink()}
                >
                  Unlink
                </button>
                <button type="button" onClick={() => setConfirming(false)}>
                  Keep it
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirming(true)}>
                Unlink…
              </button>
            )}
          </p>
        </section>
      )}
      {error && <p className="notice small">{error}</p>}

      {!user && (
        <p className="muted">Sign in to register, and to see its players, rounds and standings.</p>
      )}
      {t.me && <Entry t={t} onChange={setT} />}
      {t.detail && (
        <>
          {t.detail.standings.length > 0 && (
            <section aria-label="Standings">
              <h2>Standings</h2>
              <div className="table-scroll">
                <table className="stats-table">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Player</th>
                      <th scope="col">GW</th>
                      <th scope="col">VP</th>
                      <th scope="col">TP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.detail.standings.map((s) => (
                      <tr key={s.archonUid}>
                        <td>{s.rank}</td>
                        <th scope="row">
                          {s.name}
                          {s.finalist && <span className="badge ok">Finalist</span>}
                          {s.withdrawn && <span className="badge">Withdrew</span>}
                          {s.disqualified && <span className="badge danger">Disqualified</span>}
                        </th>
                        <td>{s.gw}</td>
                        <td>{vp(s.vp)}</td>
                        <td>{s.tp}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {t.detail.rounds.length > 0 && (
            <section aria-label="Rounds">
              <h2>Rounds</h2>
              {[...t.detail.rounds].reverse().map((r) => (
                <details key={r.number} open={r === latest}>
                  <summary>
                    Round {r.number} · {r.tables.length}{' '}
                    {r.tables.length === 1 ? 'table' : 'tables'}
                  </summary>
                  <div className="tournament-tables">
                    {r.tables.map((table) => (
                      <section
                        key={table.number}
                        className="tournament-table"
                        aria-label={`Round ${r.number}, table ${table.number}`}
                      >
                        <h3>
                          Table {table.number}{' '}
                          <span
                            className={`badge ${table.state === 'Finished' ? 'ok' : table.state === 'Invalid' ? 'danger' : ''}`.trim()}
                          >
                            {table.state}
                          </span>
                        </h3>
                        <ol>
                          {table.seats.map((s) => (
                            <li key={s.archonUid}>
                              {s.name}
                              {table.state !== 'In Progress' && (
                                <span className="muted">
                                  {' '}
                                  · {vp(s.vp)} VP{s.gw ? ' · GW' : ''}
                                </span>
                              )}
                            </li>
                          ))}
                        </ol>
                      </section>
                    ))}
                  </div>
                </details>
              ))}
            </section>
          )}

          <section aria-label="Players">
            <h2>Players</h2>
            {t.detail.players.length === 0 ? (
              <p className="muted">Nobody has registered yet.</p>
            ) : (
              <div className="table-scroll">
                <table className="stats-table">
                  <thead>
                    <tr>
                      <th scope="col">Player</th>
                      <th scope="col">VEKN</th>
                      <th scope="col">Status</th>
                      <th scope="col">Here as</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.detail.players.map((p) => (
                      <tr key={p.archonUid}>
                        <th scope="row">{p.name}</th>
                        <td>{p.veknId ?? '—'}</td>
                        <td>
                          {p.state}
                          {p.missingDecklist && t.manage && (
                            <span className="badge warning">No deck list</span>
                          )}
                        </td>
                        <td>
                          {p.account ?? <span className="muted">Not linked</span>}
                          {t.manage && p.account && !p.registered && (
                            <span className="badge warning">No deck here</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}

/**
 * The signed-in player's registration: what registering needs (a linked Archon account with a
 * VEKN number, a legal deck in the format), then their deck, check-in and dropping out.
 */
function Entry({
  t,
  onChange,
}: {
  t: TournamentDetails;
  onChange: (t: TournamentDetails) => void;
}) {
  const api = useApi();
  const me = t.me;
  const reg = me?.registration;
  const [decks, setDecks] = useState<DeckSummary[]>();
  const [deckId, setDeckId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const canPick = !!me?.veknId && t.registrationOpen && !!t.deckFormat && !reg?.dropped;
  useEffect(() => {
    if (!canPick) return;
    api<DeckSummary[]>('/decks').then(
      (all) => setDecks(all.filter((d) => d.format === t.deckFormat && d.legal)),
      () => setDecks([]),
    );
  }, [api, canPick, t.deckFormat]);
  useEffect(() => {
    if (decks && !decks.some((d) => d.id === deckId)) {
      setDeckId(decks.find((d) => d.id === reg?.deckId)?.id ?? decks[0]?.id ?? '');
    }
  }, [decks, deckId, reg?.deckId]);

  if (!me) return null;
  const send = async (path: string, method: string, body?: unknown) => {
    setBusy(true);
    setError(undefined);
    try {
      onChange(await api<TournamentDetails>(path, { method, ...(body ? { body } : {}) }));
      setConfirming(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const base = `/tournaments/${t.id}`;
  const register = (e: FormEvent) => {
    e.preventDefault();
    if (deckId) void send(`${base}/registration`, 'PUT', { deckId });
  };

  let body: ReactNode;
  if (reg?.dropped) {
    body = <p>You dropped out of this tournament.</p>;
  } else if (!reg && !t.registrationOpen) {
    if (t.state !== 'Planned') return null;
    body = <p className="muted">Registration isn’t open yet.</p>;
  } else if (!reg && !t.deckFormat) {
    body = (
      <p className="muted">
        Registering here isn’t available for {t.multideck ? 'multi-deck ' : ''}
        {t.format} tournaments yet: register in <a href={t.archonUrl}>Archon</a>.
      </p>
    );
  } else if (!reg && !me.archonLinked) {
    body = (
      <p>
        To register, first <Link to="/account">link your Archon account</Link>: the tournament runs
        there.
      </p>
    );
  } else if (!reg && !me.veknId) {
    body = (
      <p>
        Archon registers only players with a VEKN number, and your Archon account has none yet. A
        Prince of your area can sponsor you for one; then link your Archon account again on{' '}
        <Link to="/account">Your account</Link>.
      </p>
    );
  } else {
    const picker =
      canPick &&
      (decks === undefined ? (
        <p className="muted">Loading your decks…</p>
      ) : decks.length === 0 ? (
        <p>
          You have no legal {t.deckFormat} decks. <Link to="/decks">Build one</Link>, then come
          back.
        </p>
      ) : (
        <form className="toolbar" onSubmit={register}>
          <label>
            {reg ? 'Change deck' : 'Deck'}{' '}
            <select value={deckId} onChange={(e) => setDeckId(e.target.value)}>
              {decks.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.cryptCount} crypt, {d.libraryCount} library)
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="primary" disabled={busy || !deckId}>
            {reg ? 'Register this deck' : 'Register'}
          </button>
        </form>
      ));
    body = (
      <>
        {reg ? (
          <p>
            You’re registered with <strong>{reg.deckName}</strong> (version {reg.deckVersion}).
            {me.archonState && <span className="badge ok">{me.archonState}</span>}
          </p>
        ) : (
          <p>
            Register with one of your decks. It’s copied as it is now: changing the deck later
            doesn’t change what you play here, unless you register it again.
          </p>
        )}
        {picker}
        {reg && (
          <p className="toolbar">
            {t.state === 'Waiting' && me.archonState === 'Registered' && (
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void send(`${base}/check-in`, 'POST')}
              >
                Check in for the next round
              </button>
            )}
            {t.state !== 'Finished' &&
              (confirming ? (
                <>
                  <span>
                    {t.state === 'Registration'
                      ? 'Take yourself off the list?'
                      : 'Drop out of the rounds to come?'}
                  </span>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => void send(`${base}/registration`, 'DELETE')}
                  >
                    Drop out
                  </button>
                  <button type="button" onClick={() => setConfirming(false)}>
                    Stay in
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirming(true)}>
                  Drop out…
                </button>
              ))}
          </p>
        )}
      </>
    );
  }
  return (
    <section className="tournament-entry" aria-label="Your registration">
      <h2>Your registration</h2>
      {body}
      {error && <p className="notice small">{error}</p>}
    </section>
  );
}
