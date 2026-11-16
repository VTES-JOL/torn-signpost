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
import type { PlayerCommand, ServerMessage } from '@torn-signpost/protocol';
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

  it('fetches an event pushed with a gap while a catch-up is already under way', async () => {
    const s = server();
    const viewer: Viewer = { kind: 'player', seat: '1' };
    const base = s.api(viewer, 'a');
    // The next events request is answered as of when it was asked, but only once released.
    let hold = false;
    let release: (() => void) | undefined;
    const api = (async (path: string, init?: { method?: string; body?: unknown }) => {
      if (hold && path.startsWith('/games/g/events')) {
        hold = false;
        const answer = await base(path, init);
        await new Promise<void>((r) => {
          release = r;
        });
        return answer;
      }
      return base(path, init);
    }) as Api;
    const c = client(api, 'a');
    await c.start();
    const internals = c as unknown as {
      apply(e: GameEvent[], animate: boolean): void;
      catchUp(): Promise<void>;
    };

    // A catch-up starts (say, after subscribing) and sees one new event…
    s.run({ type: 'AdjustPool', seat: '2', delta: -2 }, { kind: 'player', user: 'b' });
    hold = true;
    const first = internals.catchUp();
    while (!release) await new Promise((r) => setTimeout(r, 0));
    // …while a later one, the last of the game perhaps, is pushed before it lands: a gap.
    const before = s.state.seq;
    s.run({ type: 'AdjustPool', seat: '3', delta: -3 }, { kind: 'player', user: 'c' });
    internals.apply(s.as(viewer, before), true);
    release?.();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(c.getSnapshot().view).toEqual(project(s.state, viewer));
  });

  it('never goes back to an older state when an animated push lands after a newer one', async () => {
    const s = server();
    const viewer: Viewer = { kind: 'player', seat: '1' };
    // The browser runs a view transition's update later, after other work: hold them.
    const pending: (() => void)[] = [];
    const c = new GameClient({
      gameId: 'g',
      api: s.api(viewer, 'a'),
      wsUrl: 'ws://localhost:1',
      token: async () => undefined,
      catalog,
      user: { sub: 'a', name: 'a', groups: [] },
      animate: (change) => {
        pending.push(change);
      },
    });
    (c as unknown as { connect: () => void }).connect = () => {};
    await c.start();
    const internals = c as unknown as { apply(e: GameEvent[], animate: boolean): void };

    // One push, animated: its update waits for the transition.
    let before = s.state.seq;
    s.run({ type: 'AdjustPool', seat: '2', delta: -1 }, { kind: 'player', user: 'b' });
    internals.apply(s.as(viewer, before), true);
    // The next push arrives before it runs.
    before = s.state.seq;
    s.run({ type: 'AdjustPool', seat: '3', delta: -1 }, { kind: 'player', user: 'c' });
    internals.apply(s.as(viewer, before), true);
    await new Promise((r) => setTimeout(r, 0));
    // The transitions run, in order, late.
    for (const change of pending) change();
    expect(c.getSnapshot().view).toEqual(project(s.state, viewer));
    expect(c.getSnapshot().log.at(-1)?.text).toContain('-1');
  });
});

describe('GameClient predictions', () => {
  /** The server's answer to commands waits until released, as over a slow connection. */
  function slow(s: ReturnType<typeof server>, viewer: Viewer, user: string) {
    const base = s.api(viewer, user);
    /** How each waiting command is answered: by the server double, a refusal, or given events. */
    type Answer = 'run' | 'refuse' | { events: GameEvent[] };
    const waiting: ((answer: Answer) => void)[] = [];
    const sent: string[] = [];
    const api = (async (path: string, init?: { method?: string; body?: unknown }) => {
      if (path !== '/games/g/commands') return base(path, init);
      sent.push((init?.body as { commandId: string } | undefined)?.commandId ?? '');
      const answer = await new Promise<Answer>((r) => waiting.push(r));
      if (answer === 'refuse') throw new Error('refused');
      if (answer === 'run') return base(path, init);
      return { seq: s.state.seq, events: answer.events };
    }) as Api;
    return {
      api,
      sent,
      async release(answer: Answer = 'run') {
        waiting.shift()?.(answer);
        for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
      },
    };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('shows a command at once, before the server answers, then the server’s events', async () => {
    const s = server();
    const viewer: Viewer = { kind: 'player', seat: '1' };
    const net = slow(s, viewer, 'a');
    const c = client(net.api, 'a');
    await c.start();
    const done = c.send({ type: 'AdjustPool', seat: '1', delta: -1 });
    await tick();
    expect(c.getSnapshot().view.seats[0]?.pool).toBe(29);
    expect(c.getSnapshot().log.at(-1)?.text).toContain('-1');

    await net.release();
    await done;
    expect(c.getSnapshot().view).toEqual(project(s.state, viewer));
    expect(c.getSnapshot().log).toHaveLength(2);
  });

  it('goes back when the server refuses the command', async () => {
    const s = server();
    const viewer: Viewer = { kind: 'player', seat: '1' };
    const net = slow(s, viewer, 'a');
    const c = client(net.api, 'a');
    await c.start();
    const done = c.send({ type: 'AdjustPool', seat: '1', delta: -1 });
    await tick();
    expect(c.getSnapshot().view.seats[0]?.pool).toBe(29);
    const refused = expect(done).rejects.toThrow('refused');
    await net.release('refuse');
    await refused;
    expect(c.getSnapshot().view).toEqual(project(s.state, viewer));
    expect(c.getSnapshot().view.seats[0]?.pool).toBe(30);
  });

  it('applies its own command once when the push beats the response', async () => {
    const s = server();
    const viewer: Viewer = { kind: 'player', seat: '1' };
    const net = slow(s, viewer, 'a');
    const c = client(net.api, 'a');
    const receive = (c as unknown as { receive(m: ServerMessage): void }).receive.bind(c);
    await c.start();
    const done = c.send({ type: 'AdjustPool', seat: '1', delta: -1 });
    await tick();
    // The server decides; its push arrives first, the response later.
    const before = s.state.seq;
    s.run({ type: 'AdjustPool', seat: '1', delta: -1 }, { kind: 'player', user: 'a' });
    const events = s.as(viewer, before);
    receive({ type: 'events', gameId: 'g', events, commandId: net.sent[0] ?? '' });
    expect(c.getSnapshot().view).toEqual(project(s.state, viewer));
    await net.release({ events });
    await done;
    expect(c.getSnapshot().view).toEqual(project(s.state, viewer));
    expect(c.getSnapshot().view.seats[0]?.pool).toBe(29);
    expect(c.getSnapshot().log).toHaveLength(2);
  });

  it('lays a prediction over another player’s event that lands first', async () => {
    const s = server();
    const viewer: Viewer = { kind: 'player', seat: '1' };
    const net = slow(s, viewer, 'a');
    const c = client(net.api, 'a');
    const receive = (c as unknown as { receive(m: ServerMessage): void }).receive.bind(c);
    await c.start();
    const done = c.send({ type: 'AdjustPool', seat: '1', delta: -1 });
    await tick();
    const before = s.state.seq;
    s.run({ type: 'AdjustPool', seat: '2', delta: -2 }, { kind: 'player', user: 'b' });
    receive({ type: 'events', gameId: 'g', events: s.as(viewer, before) });
    expect(c.getSnapshot().view.seats.map((x) => x.pool)).toEqual([29, 28, 30]);
    await net.release();
    await done;
    expect(c.getSnapshot().view).toEqual(project(s.state, viewer));
  });

  it('waits for the server when only it knows the outcome (a draw)', async () => {
    const s = server();
    const viewer: Viewer = { kind: 'player', seat: '1' };
    const net = slow(s, viewer, 'a');
    const c = client(net.api, 'a');
    await c.start();
    const shown = c.getSnapshot().view;
    const done = c.send({ type: 'Draw', seat: '1', count: 1 });
    await tick();
    expect(c.getSnapshot().view).toBe(shown);
    await net.release();
    await done;
    expect(c.getSnapshot().view).toEqual(project(s.state, viewer));
  });
});
