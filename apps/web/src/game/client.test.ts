import {
  type CardInfo,
  createCatalog,
  decide,
  evolve,
  type GameEvent,
  type GameState,
  newGame,
  project,
  projectEvent,
  seededRng,
  type Viewer,
} from '@torn-signpost/engine';
import testCards from '@torn-signpost/engine/test-catalog.json' with { type: 'json' };
import type { PlayerCommand } from '@torn-signpost/protocol';
import { describe, expect, it } from 'vitest';
import type { Api } from '../api.ts';
import { GameClient } from './client.ts';

const catalog = createCatalog(testCards.cards as CardInfo[]);
const rng = seededRng(4);

/** A server double: real engine state, projected per viewer, as the API would answer. */
function server() {
  let state = newGame('g');
  const events: GameEvent[] = [];
  const steps: { before: GameState; ev: GameEvent; after: GameState }[] = [];
  const run = (cmd: Parameters<typeof decide>[1], actor: Parameters<typeof decide>[2]['actor']) => {
    const r = decide(state, cmd, { actor, now: 't', rng, catalog });
    if (!r.ok) throw new Error(r.rejection.message);
    for (const ev of r.events) {
      const after = evolve(state, ev);
      steps.push({ before: state, ev, after });
      events.push(ev);
      state = after;
    }
  };
  const deck = { crypt: Array(12).fill('t-vera'), library: Array(40).fill('t-feed') };
  run(
    {
      type: 'StartGame',
      gameId: 'g',
      format: 'standard',
      seats: ['a', 'b', 'c'].map((u, i) => ({ id: String(i + 1), user: u, ...deck })),
    },
    { kind: 'system' },
  );
  const as = (viewer: Viewer, from = 0) =>
    steps.filter((s) => s.ev.seq > from).map((s) => projectEvent(s.before, s.after, s.ev, viewer));
  return {
    get state() {
      return state;
    },
    run,
    as,
    api(viewer: Viewer, user: string, opts: { hold?: boolean } = {}): Api {
      return async <T>(path: string, init?: { method?: string; body?: unknown }) => {
        if (path === '/games/g') {
          return {
            game: {
              id: 'g',
              status: 'active',
              players: ['a', 'b', 'c'].map((u) => ({ user: u, name: u.toUpperCase() })),
            },
          } as T;
        }
        if (path.startsWith('/games/g/events')) {
          const after = Number(new URL(path, 'http://x').searchParams.get('after'));
          return { seq: state.seq, events: opts.hold ? [] : as(viewer, after), more: false } as T;
        }
        if (path === '/games/g/chat') return [] as T;
        if (path === '/games/g/commands') {
          const before = state.seq;
          const body = init?.body as { command: PlayerCommand } | undefined;
          if (!body) throw new Error('missing body');
          run(body.command, { kind: 'player', user });
          return { seq: state.seq, events: as(viewer, before) } as T;
        }
        throw new Error(`unexpected ${path}`);
      };
    },
  };
}

function client(api: Api, user: string) {
  // No WebSocket in these tests; pushes are fed to apply() directly.
  const c = new GameClient({
    gameId: 'g',
    api,
    wsUrl: 'ws://localhost:1',
    token: async () => undefined,
    catalog,
    user: { sub: user, name: user, groups: [] },
  });
  (c as unknown as { connect: () => void }).connect = () => {};
  return c;
}

describe('GameClient', () => {
  it('rebuilds exactly the server’s projection from the event history, with a readable log', async () => {
    const s = server();
    s.run({ type: 'Draw', seat: '1', from: 'crypt', count: 4 }, { kind: 'player', user: 'a' });
    s.run({ type: 'Draw', seat: '2', count: 7 }, { kind: 'player', user: 'b' });
    const viewer: Viewer = { kind: 'player', seat: '2' };
    const c = client(s.api(viewer, 'b'), 'b');
    await c.start();
    const snap = c.getSnapshot();
    expect(snap.view).toEqual(project(s.state, viewer));
    expect(snap.seat).toBe('2');
    expect(snap.log.map((l) => l.text)).toEqual([
      'Game started with A, B, C',
      'A drew 4 cards from their crypt',
      'B drew 7 cards from their library: Quick Feed, Quick Feed, Quick Feed, Quick Feed, Quick Feed, Quick Feed, Quick Feed',
    ]);
  });

  it('applies its own commands, ignores duplicates and catches up after a gap', async () => {
    const s = server();
    const viewer: Viewer = { kind: 'player', seat: '1' };
    const c = client(s.api(viewer, 'a'), 'a');
    await c.start();
    await c.send({ type: 'AdjustPool', seat: '1', delta: -1 });
    expect(c.getSnapshot().view.seats[0]?.pool).toBe(29);

    // A push that repeats an applied event is ignored.
    const apply = (c as unknown as { apply(e: GameEvent[], animate: boolean): void }).apply.bind(c);
    apply(s.as(viewer, 1), true);
    expect(c.getSnapshot().log).toHaveLength(2);

    // Two commands by others, but only the second is pushed: the client fetches the missing one.
    s.run({ type: 'AdjustPool', seat: '2', delta: -2 }, { kind: 'player', user: 'b' });
    s.run({ type: 'AdjustPool', seat: '3', delta: -3 }, { kind: 'player', user: 'c' });
    apply(s.as(viewer, 3), true);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.getSnapshot().view).toEqual(project(s.state, viewer));
  });
});
