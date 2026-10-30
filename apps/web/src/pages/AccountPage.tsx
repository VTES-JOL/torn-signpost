import { DisplayName } from '@torn-signpost/protocol';
import { useState } from 'react';
import { ApiError, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { NameForm, useProfile } from '../profile.tsx';

export function AccountPage() {
  const auth = useAuth();
  const { profile } = useProfile();
  if (!auth.user) return <p className="notice">Sign in to see your account.</p>;
  if (!profile) return <p className="muted">Loading…</p>;
  return (
    <section className="account-page">
      <h1>Account</h1>
      <h2>Display name</h2>
      {profile.chosen ? (
        <>
          <p>
            <strong>{profile.name}</strong>
          </p>
          <p className="muted small">
            Display names are permanent so nobody can take over another player's name. If you need
            yours changed, ask an admin.
          </p>
        </>
      ) : (
        <NameForm submitLabel="Save" />
      )}
      {profile.groups.includes('admin') && <AdminRename />}
    </section>
  );
}

/** Admins only (AUTH-05): the old name stays retired, so it can't be reused by someone else. */
function AdminRename() {
  const api = useApi();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h2>Rename a player</h2>
      <form
        className="name-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const parsed = DisplayName.safeParse(to);
          if (!from.trim() || !parsed.success) {
            setMessage(parsed.error?.issues[0]?.message ?? 'Enter the current name');
            return;
          }
          setBusy(true);
          try {
            await api(`/users/${encodeURIComponent(from.trim())}/name`, {
              method: 'PUT',
              body: { name: parsed.data },
            });
            setMessage(`Renamed ${from.trim()} to ${parsed.data}`);
            setFrom('');
            setTo('');
          } catch (err) {
            setMessage(err instanceof ApiError ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Current name
          <input value={from} onChange={(e) => setFrom(e.target.value)} spellCheck={false} />
        </label>
        <label>
          New name
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            maxLength={24}
            spellCheck={false}
          />
        </label>
        <button type="submit" className="button" disabled={busy}>
          Rename
        </button>
        <p className="muted small" role="status">
          {message ?? 'The old name stays retired and can’t be taken by anyone else.'}
        </p>
      </form>
    </>
  );
}
