/**
 * Where the "Stop … emails" link in a notification email lands (NOTIF-02). Opening the page
 * changes nothing (mail scanners open links); the button does. No sign-in needed: the link is
 * signed.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useConfig } from '../content.tsx';

const WHAT: Record<string, string> = {
  all: 'all email',
  turn: 'turn emails',
  decision: 'decision emails',
  mention: 'mention emails',
  judge: 'judge emails',
  deadline: 'deadline emails',
  game: 'game start and oust emails',
};

export function UnsubscribePage() {
  const { apiUrl } = useConfig();
  const [params] = useSearchParams();
  const [state, setState] = useState<'ready' | 'busy' | 'done' | 'failed'>('ready');
  const what = WHAT[params.get('c') ?? ''] ?? 'these emails';
  const query = new URLSearchParams({
    u: params.get('u') ?? '',
    c: params.get('c') ?? '',
    t: params.get('t') ?? '',
  });
  return (
    <section>
      <h1>Unsubscribe</h1>
      {state === 'done' ? (
        <p role="status">
          Done: no more {what} from Torn Signpost. You can turn them back on from your{' '}
          <Link to="/account">account</Link>.
        </p>
      ) : (
        <>
          <p>Stop {what} from Torn Signpost?</p>
          <button
            type="button"
            className="primary"
            disabled={state === 'busy'}
            onClick={async () => {
              setState('busy');
              const res = await fetch(`${apiUrl}/email/unsubscribe?${query}`, {
                method: 'POST',
              }).catch(() => undefined);
              setState(res?.ok ? 'done' : 'failed');
            }}
          >
            Unsubscribe
          </button>
          {state === 'failed' && (
            <p className="notice" role="status">
              That didn’t work: the link may be damaged. Change your email settings from your{' '}
              <Link to="/account">account</Link> instead.
            </p>
          )}
        </>
      )}
    </section>
  );
}
