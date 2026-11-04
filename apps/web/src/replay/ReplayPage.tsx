/**
 * Replay (behind the `replay` flag): steps through a scenario on the real table, from any seat's
 * point of view, and lets you play on from any step. The player works on a `Timeline`, so the
 * same page can later replay recorded games (GAME-17).
 */
import { type CardCatalog, createCatalog, runScenario, type Viewer } from '@torn-signpost/engine';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useParams } from 'react-router';
import { useCards } from '../content.tsx';
import { ConsolePanel } from '../game/ConsolePanel.tsx';
import { LogPanel } from '../game/LogPanel.tsx';
import { Table } from '../game/Table.tsx';
import { ReplayClient } from './ReplayClient.ts';
import { SCENARIOS, type ScenarioFile, scenarioTitle } from './scenarios.ts';

export function ReplayListPage() {
  return (
    <section>
      <h1>Replay</h1>
      <p className="muted">
        Scripted games on the real table. Step through them from any seat, or play on from any
        point. Recorded games will appear here later.
      </p>
      <ul className="replay-list">
        {SCENARIOS.map((s) => (
          <li key={s.name}>
            <Link to={`/replay/${s.name}`}>{scenarioTitle(s.name)}</Link>
            <span className="muted small"> — {s.summary}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ReplayPage() {
  const { name = '' } = useParams();
  const cards = useCards();
  const catalog = useMemo(
    () => (cards.state === 'ready' ? createCatalog(cards.index.cards) : undefined),
    [cards],
  );
  const scenario = SCENARIOS.find((s) => s.name === name);
  if (!scenario) return <p className="notice">No scenario called “{name}”.</p>;
  if (cards.state === 'error') return <p className="notice">{cards.error}</p>;
  if (!catalog) return <p className="muted">Loading cards…</p>;
  return <ScenarioPlayer key={scenario.name} scenario={scenario} catalog={catalog} />;
}

type Panel = 'script' | 'log' | 'console';

function ScenarioPlayer({ scenario, catalog }: { scenario: ScenarioFile; catalog: CardCatalog }) {
  const run = useMemo(() => runScenario(scenario.source, catalog), [scenario, catalog]);
  const client = useMemo(() => {
    const c = new ReplayClient(run, catalog);
    const first = run.state.seats[0];
    if (first) c.setViewer({ kind: 'player', seat: first.id });
    // Open on the table just after the game starts.
    const start = run.steps.findIndex((s) => s.kind === 'command');
    c.goto(start + 1);
    return c;
  }, [run, catalog]);
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const { steps, cursor } = useSyncExternalStore(client.subscribe, client.getPosition);
  const [panel, setPanel] = useState<Panel>('script');
  const [error, setError] = useState<string>();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.target instanceof HTMLSelectElement) return;
      if (e.key === 'ArrowRight') client.goto(client.getPosition().cursor + 1);
      else if (e.key === 'ArrowLeft') client.goto(client.getPosition().cursor - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [client]);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(undefined), 5000);
    return () => clearTimeout(t);
  }, [error]);

  const viewers: { key: string; label: string; viewer: Viewer }[] = [
    ...run.state.seats.map((s) => ({
      key: `seat:${s.id}`,
      label: `Seat ${s.id} (${s.occupant})`,
      viewer: { kind: 'player', seat: s.id } as Viewer,
    })),
    { key: 'judge', label: 'Judge', viewer: { kind: 'judge' } },
    { key: 'public', label: 'Spectator', viewer: { kind: 'spectator' } },
    { key: 'all', label: 'Everything (all cards shown)', viewer: { kind: 'server' } },
  ];
  const viewerKey =
    snapshot.viewer.kind === 'player'
      ? `seat:${snapshot.viewer.seat}`
      : snapshot.viewer.kind === 'judge'
        ? 'judge'
        : snapshot.viewer.kind === 'server'
          ? 'all'
          : 'public';
  const started = snapshot.view.status !== 'setup';

  return (
    <section className="game replay">
      <div className="toolbar game-title">
        <h1>{scenarioTitle(scenario.name)}</h1>
        <span className="muted small">replay</span>
        <label className="small">
          Watching as{' '}
          <select
            value={viewerKey}
            onChange={(e) => {
              const v = viewers.find((x) => x.key === e.target.value);
              if (v) client.setViewer(v.viewer);
            }}
          >
            {viewers.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="replay-controls">
          <legend className="sr-only">Step through the replay</legend>
          <button type="button" onClick={() => client.goto(0)} disabled={cursor === 0}>
            ⏮<span className="sr-only">First step</span>
          </button>
          <button type="button" onClick={() => client.goto(cursor - 1)} disabled={cursor === 0}>
            ◀<span className="sr-only">Previous step</span>
          </button>
          <span className="small">
            Step {cursor} of {steps.length}
          </span>
          <button
            type="button"
            className="primary"
            onClick={() => client.goto(cursor + 1)}
            disabled={cursor === steps.length}
          >
            ▶<span className="sr-only">Next step</span>
          </button>
          <button
            type="button"
            onClick={() => client.goto(steps.length)}
            disabled={cursor === steps.length}
          >
            ⏭<span className="sr-only">Last step</span>
          </button>
        </fieldset>
      </div>
      {steps.some((s) => s.live) && (
        <p className="notice small replay-branch">
          You are playing on from step {steps.findIndex((s) => s.live)}; the rest of the script is
          set aside.{' '}
          <button type="button" onClick={() => client.reset()}>
            Back to the script
          </button>
        </p>
      )}
      {run.failure && (
        <p className="notice small" role="status">
          This scenario stops early at line {run.failure.line}: {run.failure.message}
        </p>
      )}
      {error && (
        <p className="toast" role="alert">
          {error}
        </p>
      )}
      <div className="game-layout">
        <div className="game-table">
          {started ? (
            <Table
              client={client}
              snapshot={snapshot}
              catalog={catalog}
              judge={snapshot.viewer.kind === 'judge'}
              onError={setError}
            />
          ) : (
            <p className="notice">Setting up the table: step forward to start the game.</p>
          )}
        </div>
        <aside className="game-side">
          <div className="tabs" role="tablist">
            {(['script', 'log', 'console'] as const).map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={panel === p}
                onClick={() => setPanel(p)}
              >
                {p === 'script' ? 'Script' : p === 'log' ? 'Log' : 'Console'}
              </button>
            ))}
          </div>
          {panel === 'script' && (
            <Script
              source={scenario.source}
              steps={steps}
              cursor={cursor}
              onGoto={(n) => client.goto(n)}
            />
          )}
          {panel === 'log' && <LogPanel client={client} snapshot={snapshot} canChat="none" />}
          {panel === 'console' &&
            (started ? (
              <ConsolePanel client={client} snapshot={snapshot} catalog={catalog} />
            ) : (
              <p className="muted small">The console opens once the game has started.</p>
            ))}
        </aside>
      </div>
    </section>
  );
}

/** The script with the current step highlighted; click a line to jump to it. */
function Script(props: {
  source: string;
  steps: ReturnType<ReplayClient['getPosition']>['steps'];
  cursor: number;
  onGoto: (cursor: number) => void;
}) {
  const { steps, cursor, onGoto } = props;
  const current = steps[cursor - 1];
  const stepAt = new Map(steps.flatMap((s, i) => (s.line ? [[s.line, i] as const] : [])));
  const live = steps.flatMap((s, i) => (s.live ? [{ step: s, i }] : []));
  const currentRef = useRef<HTMLLIElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the cursor
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);
  const lines = props.source.split('\n');
  return (
    <ol className="script" aria-label="Scenario script">
      {lines.map((text, n) => {
        const line = n + 1;
        const i = stepAt.get(line);
        if (!text.trim()) return null;
        if (i === undefined) {
          return (
            <li key={line} className="script-note">
              {text.replace(/^\s*#\s?/, '')}
            </li>
          );
        }
        const step = steps[i];
        const isCurrent = step === current;
        return (
          <li
            key={line}
            ref={isCurrent ? currentRef : undefined}
            className={[
              'script-step',
              isCurrent ? 'current' : '',
              i < cursor ? 'done' : '',
              step?.failure ? 'failed' : '',
            ].join(' ')}
          >
            <button type="button" onClick={() => onGoto(i + 1)} aria-current={isCurrent}>
              <span className="script-line">{line}</span>
              <code>{text}</code>
            </button>
            {step?.failure && <p className="small">{step.failure}</p>}
          </li>
        );
      })}
      {live.length > 0 && <li className="script-note">Played here:</li>}
      {live.map(({ step, i }) => (
        <li
          key={`live-${i}`}
          ref={step === current ? currentRef : undefined}
          className={['script-step', step === current ? 'current' : '', 'done'].join(' ')}
        >
          <button type="button" onClick={() => onGoto(i + 1)} aria-current={step === current}>
            <span className="script-line">·</span>
            <code>{step.text}</code>
          </button>
        </li>
      ))}
    </ol>
  );
}
