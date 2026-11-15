/**
 * The player's Archon account (docs/m7-plan.md M7.1): Archon, the VEKN's tournament manager, runs
 * the tournaments played here, and needs to know who each player is there, and their VEKN number.
 */
import type { ArchonCallbackResult, ArchonLink, ArchonLinkStart } from '@torn-signpost/protocol';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';

const message = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

export function ArchonAccount() {
  const api = useApi();
  const [link, setLink] = useState<ArchonLink>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const [params] = useSearchParams();
  useEffect(() => {
    api<ArchonLink>('/me/archon').then(setLink, (e) => setError(message(e)));
  }, [api]);

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { url } = await api<ArchonLinkStart>('/me/archon/link', { method: 'POST' });
      window.location.assign(url);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  const unlink = async () => {
    setBusy(true);
    try {
      setLink(await api<ArchonLink>('/me/archon', { method: 'DELETE' }));
      setConfirming(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="archon-account" aria-label="Archon account">
      <h2>Archon account</h2>
      <p className="muted small">
        Tournaments here are run with Archon, the VEKN’s tournament manager. To play in one, link
        your Archon account: it tells us who you are there and your VEKN number.
      </p>
      {params.get('archon') === 'linked' && link?.linked && (
        <p className="notice small" role="status">
          Your Archon account is linked.
        </p>
      )}
      {!link && !error && <p className="muted">Loading…</p>}
      {link?.linked && (
        <>
          <p>
            Linked
            {link.veknId ? (
              <>
                {' '}
                · VEKN number <strong>{link.veknId}</strong>
              </>
            ) : null}
          </p>
          {!link.veknId && (
            <p className="notice small">
              Your Archon account has no VEKN number yet, and tournaments need one. A Prince can
              give you one in Archon; then link your account again to update it here.
            </p>
          )}
          <p className="toolbar">
            <button type="button" disabled={busy} onClick={() => void start()}>
              Link again
            </button>
            {confirming ? (
              <>
                <span className="small">Unlink your Archon account?</span>
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
        </>
      )}
      {link && !link.linked && (
        <p>
          <button type="button" className="primary" disabled={busy} onClick={() => void start()}>
            Link your Archon account
          </button>
        </p>
      )}
      {error && <p className="notice small">{error}</p>}
    </section>
  );
}

/**
 * Archon sends the player back here, with a code to finish what they started (or why it didn't):
 * linking their own account, or a tournament they run.
 */
export function ArchonCallback() {
  const api = useApi();
  const auth = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  // The server completes a link request once: post it once, even if the effect runs twice.
  const sent = useRef(false);
  useEffect(() => {
    if (!auth.user || sent.current) return;
    sent.current = true;
    const state = params.get('state') ?? '';
    const code = params.get('code');
    const err = params.get('error');
    api<ArchonCallbackResult>('/archon/callback', {
      method: 'POST',
      body: { state, ...(code ? { code } : {}), ...(err ? { error: err } : {}) },
    }).then(
      // Replacing this page leaves the code out of the history.
      (done) =>
        navigate(
          done.purpose === 'tournament'
            ? `/tournaments/${done.tournamentId}?linked=1`
            : '/account?archon=linked',
          { replace: true },
        ),
      (e) => setError(message(e)),
    );
  }, [api, auth.user, params, navigate]);
  if (!auth.user) return <p className="notice">Sign in to finish linking with Archon.</p>;
  return (
    <section className="notice">
      <p role="status">{error ?? 'Finishing the link with Archon…'}</p>
      {error && (
        <p>
          <Link to="/account">Your account</Link> · <Link to="/tournaments">Tournaments</Link>
        </p>
      )}
    </section>
  );
}
