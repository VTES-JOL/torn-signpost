import type { ClientConfig, HealthResponse } from '@torn-signpost/protocol';
import { useEffect, useState } from 'react';
import { DarkPackFooter } from './components/DarkPackFooter.tsx';
import { loadConfig } from './config.ts';

type ApiStatus =
  | { state: 'checking' }
  | { state: 'up'; health: HealthResponse }
  | { state: 'down'; error: string };

export function App() {
  const [config, setConfig] = useState<ClientConfig>();
  const [api, setApi] = useState<ApiStatus>({ state: 'checking' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await loadConfig();
        if (cancelled) return;
        setConfig(cfg);
        const res = await fetch(`${cfg.apiUrl}/health`);
        const health = (await res.json()) as HealthResponse;
        if (!cancelled) setApi({ state: 'up', health });
      } catch (err) {
        if (!cancelled) setApi({ state: 'down', error: String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="page">
      <main className="hero">
        <h1>Torn Signpost</h1>
        <p className="tagline">
          Play <cite>Vampire: The Eternal Struggle</cite> online — in real time or play-by-post, on
          any device. Free and open source.
        </p>
        <p className="beta">Live beta · under construction</p>
        <p className="status" aria-live="polite">
          {api.state === 'checking' && 'Checking server…'}
          {api.state === 'up' &&
            `Server online · ${api.health.stage} · engine ${api.health.engineVersion}`}
          {api.state === 'down' && 'Server unreachable'}
        </p>
      </main>
      <DarkPackFooter contentUrl={config?.contentUrl} />
    </div>
  );
}
