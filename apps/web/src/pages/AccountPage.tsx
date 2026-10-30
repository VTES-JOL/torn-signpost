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
      <p className="muted small">
        Games and decks you've already joined or saved keep the name you used at the time.
      </p>
      <NameForm submitLabel="Save" />
    </section>
  );
}
