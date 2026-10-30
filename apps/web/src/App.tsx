import type { ClientConfig, HealthResponse } from '@torn-signpost/protocol';
import { useEffect, useState } from 'react';
import { BrowserRouter, Link, NavLink, Outlet, Route, Routes, useLocation } from 'react-router';
import { AuthProvider, useAuth } from './auth.tsx';
import { DarkPackFooter } from './components/DarkPackFooter.tsx';
import { loadConfig } from './config.ts';
import { CardsProvider, ConfigProvider, useConfig } from './content.tsx';
import { GamePage } from './game/GamePage.tsx';
import { AccountPage } from './pages/AccountPage.tsx';
import { AuthCallback } from './pages/AuthCallback.tsx';
import { CardsPage } from './pages/CardsPage.tsx';
import { DeckEditor } from './pages/DeckEditor.tsx';
import { DecksPage } from './pages/DecksPage.tsx';
import { GamesPage } from './pages/GamesPage.tsx';
import { NameForm, ProfileProvider, useProfile } from './profile.tsx';

export function App() {
  const [config, setConfig] = useState<ClientConfig>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    loadConfig().then(setConfig, (e) => setError(String(e)));
  }, []);
  if (error) return <p className="notice">Could not load the site configuration: {error}</p>;
  if (!config) return null;
  return (
    <ConfigProvider config={config}>
      <AuthProvider config={config}>
        <ProfileProvider>
          <CardsProvider>
            <BrowserRouter>
              <Routes>
                <Route element={<Layout />}>
                  <Route index element={<Home />} />
                  <Route path="cards" element={<CardsPage />} />
                  <Route path="decks" element={<DecksPage />} />
                  <Route path="decks/new" element={<DeckEditor />} />
                  <Route path="decks/:id" element={<DeckEditor />} />
                  <Route path="games" element={<GamesPage />} />
                  <Route path="games/:id" element={<GamePage />} />
                  <Route path="account" element={<AccountPage />} />
                  <Route path="auth/callback" element={<AuthCallback />} />
                  <Route path="*" element={<p className="notice">Page not found.</p>} />
                </Route>
              </Routes>
            </BrowserRouter>
          </CardsProvider>
        </ProfileProvider>
      </AuthProvider>
    </ConfigProvider>
  );
}

function Layout() {
  const { contentUrl } = useConfig();
  return (
    <div className="page">
      <Header />
      <main className="main">
        <ChooseName />
        <Outlet />
      </main>
      <DarkPackFooter contentUrl={contentUrl} />
    </div>
  );
}

/** Asks a newly signed-in user for a display name (AUTH-05) until they pick one or put it off. */
function ChooseName() {
  const { profile } = useProfile();
  const { pathname } = useLocation();
  const [later, setLater] = useState(false);
  if (!profile || profile.chosen || later || pathname === '/account') return null;
  return (
    <section className="notice choose-name" aria-label="Choose a display name">
      <p>
        <strong>Choose a display name.</strong> Other players see you as “{profile.name}” until you
        do.
      </p>
      <NameForm submitLabel="Use this name">
        <button type="button" onClick={() => setLater(true)}>
          Later
        </button>
      </NameForm>
    </section>
  );
}

function Header() {
  const auth = useAuth();
  const { profile } = useProfile();
  const [devName, setDevName] = useState('');
  return (
    <header className="header">
      <Link to="/" className="brand">
        Torn Signpost
      </Link>
      <nav className="nav" aria-label="Main">
        <NavLink to="/games">Games</NavLink>
        <NavLink to="/cards">Cards</NavLink>
        <NavLink to="/decks">Decks</NavLink>
      </nav>
      <div className="account">
        {auth.user ? (
          <>
            <NavLink to="/account" className="muted" title="Account">
              {profile?.name ?? auth.user.name}
            </NavLink>
            <button type="button" onClick={() => auth.signOut()}>
              Sign out
            </button>
          </>
        ) : auth.isLocal ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void auth.signIn(devName);
            }}
          >
            <input
              aria-label="Dev user name"
              placeholder="dev user (e.g. alice)"
              value={devName}
              onChange={(e) => setDevName(e.target.value)}
              size={14}
            />
            <button type="submit">Sign in</button>
          </form>
        ) : (
          <button type="button" onClick={() => void auth.signIn()}>
            Sign in
          </button>
        )}
      </div>
    </header>
  );
}

type ApiStatus =
  | { state: 'checking' }
  | { state: 'up'; health: HealthResponse }
  | { state: 'down'; error: string };

function Home() {
  const { apiUrl } = useConfig();
  const [api, setApi] = useState<ApiStatus>({ state: 'checking' });
  useEffect(() => {
    let cancelled = false;
    fetch(`${apiUrl}/health`)
      .then((r) => r.json() as Promise<HealthResponse>)
      .then(
        (health) => !cancelled && setApi({ state: 'up', health }),
        (err) => !cancelled && setApi({ state: 'down', error: String(err) }),
      );
    return () => {
      cancelled = true;
    };
  }, [apiUrl]);
  return (
    <section className="hero">
      <h1>Torn Signpost</h1>
      <p className="tagline">
        Play <cite>Vampire: The Eternal Struggle</cite> online — in real time or play-by-post, on
        any device. Free and open source.
      </p>
      <p className="beta">Live beta · under construction</p>
      <p>
        <Link to="/cards">Browse the cards</Link> or <Link to="/decks">build a deck</Link>.
      </p>
      <p className="status" aria-live="polite">
        {api.state === 'checking' && 'Checking server…'}
        {api.state === 'up' &&
          `Server online · ${api.health.stage} · engine ${api.health.engineVersion}`}
        {api.state === 'down' && 'Server unreachable'}
      </p>
    </section>
  );
}
