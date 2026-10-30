/**
 * The signed-in user's profile (AUTH-05). Until they choose a display name, other players see a
 * "Player 1a2b" placeholder, so the layout asks for one after the first sign-in.
 */
import { DisplayName, type Profile } from '@torn-signpost/protocol';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { ApiError, useApi } from './api.ts';
import { useAuth } from './auth.tsx';

interface ProfileContextValue {
  profile?: Profile;
  rename(name: string): Promise<void>;
}

const ProfileContext = createContext<ProfileContextValue>({ rename: async () => {} });
export const useProfile = () => useContext(ProfileContext);

export function ProfileProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const sub = useAuth().user?.sub;
  const [profile, setProfile] = useState<Profile>();

  useEffect(() => {
    setProfile(undefined);
    if (!sub) return;
    let cancelled = false;
    api<Profile>('/me').then(
      (p) => !cancelled && setProfile(p),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api, sub]);

  const rename = useCallback(
    async (name: string) =>
      setProfile(await api<Profile>('/me', { method: 'PUT', body: { name } })),
    [api],
  );
  const value = useMemo(() => ({ ...(profile ? { profile } : {}), rename }), [profile, rename]);
  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

/** Name input with client-side checks; the server decides whether the name is free. */
export function NameForm(props: {
  submitLabel: string;
  onDone?: () => void;
  children?: ReactNode;
}) {
  const { rename } = useProfile();
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="name-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const parsed = DisplayName.safeParse(name);
        if (!parsed.success) {
          setMessage(parsed.error.issues[0]?.message);
          return;
        }
        setBusy(true);
        setMessage(undefined);
        try {
          await rename(parsed.data);
          setMessage('Saved');
          props.onDone?.();
        } catch (err) {
          setMessage(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Display name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Nocturne"
          maxLength={24}
          autoComplete="nickname"
          spellCheck={false}
        />
      </label>
      <button type="submit" className="button primary" disabled={busy}>
        {props.submitLabel}
      </button>
      {props.children}
      <p className="muted small" role="status">
        {message ??
          '3–24 letters, digits, _ or -. Shown to other players and permanent: choose carefully.'}
      </p>
    </form>
  );
}
