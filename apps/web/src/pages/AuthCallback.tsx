import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../auth.tsx';

/** Cognito redirects here with an authorization code after sign-in. */
export function AuthCallback() {
  const auth = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    auth.completeSignIn(params).then(
      (back) => navigate(back, { replace: true }),
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [auth, params, navigate]);
  return <p className="notice">{error ?? 'Signing in…'}</p>;
}
