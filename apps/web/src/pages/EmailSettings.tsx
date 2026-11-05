/**
 * Email notifications on the Account page (NOTIF-02): what to email at once, what to save for the
 * digest, and what never to email. Email only goes out while you're away from the site.
 */
import {
  EMAIL_CATEGORIES,
  type EmailCategory,
  type EmailMode,
  type EmailPrefs,
  type EmailSettings as Settings,
} from '@torn-signpost/protocol';
import { useEffect, useState } from 'react';
import { ApiError, useApi } from '../api.ts';

const LABELS: Record<EmailCategory, string> = {
  turn: 'Your turn',
  decision: 'Decisions waiting on you (blocks, resolutions…)',
  mention: 'Mentions in chat',
  judge: 'Judge calls and rulings',
  deadline: 'Deadline reminders',
  game: 'Games starting, and being ousted',
};

const MODES: [EmailMode, string][] = [
  ['immediate', 'At once'],
  ['digest', 'In the digest'],
  ['off', 'Never'],
];

export function EmailSettings() {
  const api = useApi();
  const [settings, setSettings] = useState<Settings>();
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    api<Settings>('/me/email').then(setSettings, (e) =>
      setMessage(e instanceof ApiError ? e.message : String(e)),
    );
  }, [api]);
  if (!settings) return <p className="muted">{message ?? 'Loading…'}</p>;

  const save = async (prefs: EmailPrefs) => {
    setSettings({ ...settings, prefs });
    try {
      setSettings(await api<Settings>('/me/email', { method: 'PUT', body: prefs }));
      setMessage('Saved');
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    }
  };
  const { prefs } = settings;
  return (
    <>
      <h2>Email</h2>
      <p className="muted small">
        {settings.address
          ? `Sent to ${settings.address}, the address you sign in with, and only while you’re away from the site: if you’re here, you’ll see it here instead.`
          : 'No verified email address yet: sign in again to add yours.'}
      </p>
      <table className="email-prefs">
        <tbody>
          {EMAIL_CATEGORIES.map((c) => (
            <tr key={c}>
              <th scope="row">{LABELS[c]}</th>
              <td>
                <select
                  aria-label={LABELS[c]}
                  value={prefs.modes[c]}
                  onChange={(e) =>
                    void save({
                      ...prefs,
                      modes: { ...prefs.modes, [c]: e.target.value as EmailMode },
                    })
                  }
                >
                  {MODES.map(([m, label]) => (
                    <option key={m} value={m}>
                      {label}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row">Digest</th>
            <td>
              <select
                aria-label="Digest"
                value={prefs.digest}
                onChange={(e) =>
                  void save({ ...prefs, digest: e.target.value as EmailPrefs['digest'] })
                }
              >
                <option value="daily">Daily, at 17:00 UTC</option>
                <option value="twice-daily">Twice daily, at 05:00 and 17:00 UTC</option>
              </select>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="muted small" role="status">
        {message}
      </p>
    </>
  );
}
