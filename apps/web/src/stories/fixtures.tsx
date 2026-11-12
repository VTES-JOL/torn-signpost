/**
 * Story helpers. Stories render inside the app's own providers, and their games come from the
 * engine's scenario scripts, run in the browser exactly as the Replay page runs them: real game
 * states, not hand-made ones, and commands sent from a story play on from there.
 *
 * Scenarios in `packages/engine/scenarios/real-cards` name cards by VEKN ID; their names and images
 * come from the content pack at runtime (LEGAL-08), through Storybook's `/content` proxy
 * (.storybook/main.ts). The other scenarios use the invented test cards in `catalog.json`.
 */
import type { CardRecord } from '@torn-signpost/cards';
import {
  type CardCatalog,
  type CardInfo,
  createCatalog,
  type GameState,
  runScenario,
  type Viewer,
} from '@torn-signpost/engine';
import type { ClientConfig, FeatureFlags, PlayerCommand } from '@torn-signpost/protocol';
import { type ReactNode, useMemo, useSyncExternalStore } from 'react';
import { MemoryRouter } from 'react-router';
import { action } from 'storybook/actions';
import invented from '../../../../packages/engine/scenarios/catalog.json';
import { AuthProvider } from '../auth.tsx';
import { type Cards, CardsProvider, ConfigProvider, useCards } from '../content.tsx';
import type { GameSnapshot } from '../game/client.ts';
import { ReplayClient } from '../replay/ReplayClient.ts';

/** Every feature on, as in local development. */
const FLAGS: FeatureFlags = {
  replay: true,
  presence: true,
  clock: true,
  judgeCalls: true,
  notifications: true,
  email: true,
  stats: true,
};

const CONFIG: ClientConfig = {
  stage: 'local',
  apiUrl: 'http://localhost:3001',
  wsUrl: 'ws://localhost:3001/ws',
  contentUrl: '/content',
  auth: { domain: 'auth.invalid', userPoolId: 'storybook', clientId: 'storybook' },
  flags: FLAGS,
};

/** The app's providers, around every story. `parameters.flags` turns features off. */
export function StoryProviders({
  flags,
  children,
}: {
  flags?: FeatureFlags | undefined;
  children: ReactNode;
}) {
  const config = useMemo(() => ({ ...CONFIG, flags: { ...FLAGS, ...flags } }), [flags]);
  return (
    <ConfigProvider config={config}>
      <AuthProvider config={config}>
        <CardsProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </CardsProvider>
      </AuthProvider>
    </ConfigProvider>
  );
}

type ReadyCards = Extract<Cards, { state: 'ready' }>;

/** Renders once the card database has loaded. */
export function WithCards({ children }: { children: (cards: ReadyCards) => ReactNode }) {
  const cards = useCards();
  if (cards.state === 'error') return <p className="notice">{cards.error}</p>;
  if (cards.state === 'loading') return <p className="muted">Loading cards…</p>;
  return children(cards);
}

/** A card from the content pack by VEKN ID. */
export function WithCard({
  id,
  children,
}: {
  id: string;
  children: (card: CardRecord) => ReactNode;
}) {
  return (
    <WithCards>
      {(cards) => {
        const card = cards.get(id);
        return card ? children(card) : <p className="notice">No card {id}</p>;
      }}
    </WithCards>
  );
}

const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('../../../../packages/engine/scenarios/**/*.scenario', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  ).map(([path, source]) => [
    path.replace(/^.*\/scenarios\//, '').replace(/\.scenario$/, ''),
    source,
  ]),
);

const INVENTED: CardCatalog = createCatalog(invented.cards as unknown as CardInfo[]);

export interface ScenarioGame {
  client: ReplayClient;
  snapshot: GameSnapshot;
  view: GameState;
  /** The viewer's seat, if they have one. */
  seat: string | undefined;
  catalog: CardCatalog;
  seatName: (seat: string) => string;
  /** Plays the command on from this point, and shows it in the Actions panel. */
  send: (command: PlayerCommand) => void;
}

export interface ScenarioProps {
  /** A script in packages/engine/scenarios: `13-judge-calls`, `real-cards/05-combat-with-cards`. */
  name: string;
  /** Show the game as it was after this line of the script; the whole script by default. */
  line?: number;
  /** Whose view to show; the first seat by default. */
  viewer?: Viewer;
  /** Changes the state before it is shown, e.g. to move the clock to the present. */
  adjust?: (view: GameState) => GameState;
  children: (game: ScenarioGame) => ReactNode;
}

/** A game from a scenario script, at one of its lines, seen by one viewer. */
export function Scenario(props: ScenarioProps) {
  const cards = useCards();
  const real = props.name.startsWith('real-cards/');
  const catalog = useMemo(
    () =>
      !real ? INVENTED : cards.state === 'ready' ? createCatalog(cards.index.cards) : undefined,
    [real, cards],
  );
  if (real && cards.state === 'error') return <p className="notice">{cards.error}</p>;
  if (!catalog) return <p className="muted">Loading cards…</p>;
  return <ScenarioAt {...props} catalog={catalog} />;
}

const logSend = action('send');

function ScenarioAt({
  name,
  line,
  viewer,
  adjust,
  children,
  catalog,
}: ScenarioProps & { catalog: CardCatalog }) {
  const viewerKey = JSON.stringify(viewer ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the viewer is compared by value
  const client = useMemo(() => {
    const source = SOURCES[name];
    if (source === undefined) throw new Error(`No scenario called ${name}`);
    const run = runScenario(source, catalog);
    if (run.failure) console.warn(`${name} stops at line ${run.failure.line}`, run.failure);
    const c = new ReplayClient(run, catalog);
    // Every command shows in the Actions panel, whichever component sends it.
    const send = c.send.bind(c);
    c.send = (command) => {
      logSend(command);
      return send(command);
    };
    const first = run.state.seats[0];
    c.setViewer(viewer ?? (first ? { kind: 'player', seat: first.id } : { kind: 'spectator' }));
    c.goto(
      line === undefined
        ? run.steps.length
        : run.steps.findLastIndex((s) => (s.line ?? 0) <= line) + 1,
    );
    return c;
  }, [name, line, viewerKey, catalog]);
  const live = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const view = adjust ? adjust(live.view) : live.view;
  const snapshot = adjust ? { ...live, view } : live;
  return children({
    client,
    snapshot,
    view,
    seat: snapshot.seat,
    catalog,
    seatName: client.seatName,
    send: (command) => {
      client.send(command).catch((e: unknown) => console.warn(String(e)));
    },
  });
}

/** Where a scenario's game screen sits: the table and side panel layout of the game page. */
export function GameFrame({ children, side }: { children: ReactNode; side?: ReactNode }) {
  return (
    <section className="game">
      <div className="game-layout">
        <div className="game-table">{children}</div>
        {side && <aside className="game-side">{side}</aside>}
      </div>
    </section>
  );
}
