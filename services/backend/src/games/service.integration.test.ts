import {
  evolve,
  type GameEvent,
  type GameState,
  newGame,
  project,
  seededRng,
} from '@torn-signpost/engine';
import type { CommandRequest, ServerMessage } from '@torn-signpost/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Identity } from '../auth.ts';
import type { GameStore } from '../db/store.ts';
import type { ConnectionGateway } from '../realtime/gateway.ts';
import { ABSENCE_DELAY_MS, Fanout, Realtime } from '../realtime/realtime.ts';
import { testContent, testDeck } from '../testing/content.ts';
import { dynamoAvailable, testStore } from '../testing/dynamo.ts';
import { presenceKey, type TimerPayload, type Timers } from '../timers/timers.ts';
import { GameService, viewerOf } from './service.ts';

const available = await dynamoAvailable();

const user = (sub: string, groups: string[] = []): Identity => ({
  kind: 'user',
  sub,
  name: sub,
  groups,
});
const alice = user('alice');
const bob = user('bob');
const carol = user('carol');
const dave = user('dave');
const judge = user('jo', ['judge']);
const admin = user('ada', ['admin']);
const guest: Identity = { kind: 'guest' };
const deck = testDeck;

/** A gateway that records what each connection was sent. */
function recordingGateway() {
  const sent = new Map<string, ServerMessage[]>();
  const gone = new Set<string>();
  const gateway: ConnectionGateway = {
    async post(id, message) {
      if (gone.has(id)) return false;
      sent.set(id, [...(sent.get(id) ?? []), message]);
      return true;
    },
  };
  return { gateway, sent, gone };
}

/** Timers that fire only when the test says so. */
function manualTimers() {
  const scheduled = new Map<string, { at: Date; payload: TimerPayload }>();
  const timers: Timers = {
    async schedule(key, at, payload) {
      scheduled.set(key, { at, payload });
    },
    async cancel(key) {
      scheduled.delete(key);
    },
  };
  return { timers, scheduled };
}

let n = 0;
function service(
  store: GameStore,
  gateway: ConnectionGateway,
  seed = 1,
  timers?: Timers,
  presence = true,
) {
  const games = new GameService({
    store,
    content: testContent,
    rng: seededRng(seed),
    publisher: new Fanout(store, gateway),
    newId: () => `g${++n}-${seed}`,
    now: () => new Date('2026-11-05T10:00:00Z'),
    presence,
  });
  const realtime = new Realtime(store, gateway, games, {
    presence,
    ...(timers ? { timers } : {}),
    now: () => new Date('2026-11-05T10:00:00Z'),
  });
  return { games, realtime };
}

/** Pushed event batches, leaving out presence bookkeeping. */
const pushedEvents = (messages: ServerMessage[] | undefined) =>
  (messages ?? []).filter(
    (m): m is Extract<ServerMessage, { type: 'events' }> =>
      m.type === 'events' &&
      !m.events.every((e) => e.type === 'PlayerPresent' || e.type === 'PlayerAbsent'),
  );

let commandCounter = 0;
const cmd = (
  command: CommandRequest['command'],
  extra: Partial<CommandRequest> = {},
): CommandRequest => ({
  commandId: `cmd-${++commandCounter}-${Date.now()}`,
  command,
  ...extra,
});

describe.skipIf(!available)('game service (DynamoDB Local)', () => {
  let store: GameStore;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ store, cleanup } = await testStore()));
  afterAll(() => cleanup?.());

  async function startedGame(games: GameService, visibility: 'public' | 'private' = 'public') {
    const g = await games.create(alice, {
      name: 'Test',
      format: 'standard',
      visibility,
      maxSeats: 3,
    });
    for (const p of [alice, bob, carol]) await games.join(p, g.id, { deck });
    await games.start(alice, g.id);
    const details = await games.details(alice, g.id);
    const seatOf = (who: Identity) =>
      details.view?.seats.find((s) => who.kind === 'user' && s.occupant === who.sub)?.id ?? '';
    return { id: g.id, seatOf };
  }

  describe('lobby', () => {
    it('creates, lists, joins and enforces seats', async () => {
      const { games } = service(store, recordingGateway().gateway);
      const g = await games.create(alice, {
        name: 'Open table',
        format: 'standard',
        visibility: 'public',
        maxSeats: 3,
      });
      expect((await games.list(guest, 'open')).map((x) => x.id)).toContain(g.id);
      await games.join(alice, g.id, { deck });
      await expect(games.join(alice, g.id, { deck })).rejects.toMatchObject({
        code: 'already_joined',
      });
      await games.join(bob, g.id, { deck });
      await games.join(carol, g.id, { deck });
      await expect(games.join(dave, g.id, { deck })).rejects.toMatchObject({ code: 'full' });
      expect((await games.list(bob, 'mine')).map((x) => x.id)).toContain(g.id);
    });

    it('validates seats and decks', async () => {
      const { games } = service(store, recordingGateway().gateway);
      await expect(
        games.create(alice, { name: 'x', format: 'duel', visibility: 'public', maxSeats: 3 }),
      ).rejects.toMatchObject({ code: 'invalid_seats' });
      await expect(
        games.create(guest, { name: 'x', format: 'standard', visibility: 'public', maxSeats: 3 }),
      ).rejects.toMatchObject({ status: 401 });
      const g = await games.create(alice, {
        name: 'x',
        format: 'standard',
        visibility: 'public',
        maxSeats: 3,
      });
      await expect(
        games.join(bob, g.id, { deck: { ...deck, crypt: [{ id: 't-feed', count: 12 }] } }),
      ).rejects.toMatchObject({
        code: 'illegal_deck',
        message: expect.stringContaining('belongs in the library'),
      });
      await expect(
        games.join(bob, g.id, { deck: { ...deck, library: [{ id: 't-feed', count: 30 }] } }),
      ).rejects.toMatchObject({ code: 'illegal_deck', message: expect.stringContaining('60–90') });
    });

    it('keeps private games to their players, judges and admins', async () => {
      const { games } = service(store, recordingGateway().gateway);
      const { id } = await startedGame(games, 'private');
      expect((await games.list(guest, 'active')).map((x) => x.id)).not.toContain(id);
      await expect(games.details(dave, id)).rejects.toMatchObject({ status: 404 });
      await expect(games.details(guest, id)).rejects.toMatchObject({ status: 404 });
      await expect(games.details(judge, id)).resolves.toBeDefined();
      await expect(games.details(bob, id)).resolves.toBeDefined();
    });

    it('only the creator starts, with enough players, once', async () => {
      const { games } = service(store, recordingGateway().gateway);
      const g = await games.create(alice, {
        name: 'x',
        format: 'standard',
        visibility: 'public',
        maxSeats: 4,
      });
      await games.join(alice, g.id, { deck });
      await games.join(bob, g.id, { deck });
      await expect(games.start(alice, g.id)).rejects.toMatchObject({ code: 'not_enough_players' });
      await games.join(carol, g.id, { deck });
      await expect(games.start(bob, g.id)).rejects.toMatchObject({ status: 403 });
      const started = await games.start(alice, g.id);
      expect(started.status).toBe('active');
      expect((await games.list(guest, 'active')).map((x) => x.id)).toContain(g.id);
      expect((await games.list(guest, 'open')).map((x) => x.id)).not.toContain(g.id);
      await expect(games.start(alice, g.id)).rejects.toMatchObject({ code: 'not_open' });
      await expect(games.join(dave, g.id, { deck })).rejects.toMatchObject({ code: 'not_open' });
    });
  });

  describe('leaving and chat', () => {
    it('lets players leave before the game starts', async () => {
      const { games } = service(store, recordingGateway().gateway);
      const g = await games.create(alice, {
        name: 'x',
        format: 'standard',
        visibility: 'public',
        maxSeats: 3,
      });
      await games.join(bob, g.id, { deck });
      expect((await games.leave(bob, g.id)).players).toEqual([]);
      await expect(games.leave(bob, g.id)).rejects.toMatchObject({ code: 'not_joined' });
      expect((await games.list(bob, 'mine')).map((x) => x.id)).not.toContain(g.id);
      await games.join(bob, g.id, { deck });
      expect((await games.details(alice, g.id)).game.players.map((p) => p.user)).toEqual(['bob']);
    });

    it('lets players and judges chat, spectators only read, and pushes messages', async () => {
      const rec = recordingGateway();
      const { games, realtime } = service(store, rec.gateway);
      const { id } = await startedGame(games);
      await realtime.connect('c-guest', guest);
      await realtime.message('c-guest', JSON.stringify({ type: 'subscribe', gameId: id }));
      const msg = await games.chat(bob, id, { text: 'Hello @alice' });
      expect(msg).toMatchObject({ user: 'bob', text: 'Hello @alice', seq: 1 });
      await games.chat(judge, id, { text: 'Judge here' });
      await expect(games.chat(dave, id, { text: 'hi' })).rejects.toMatchObject({
        code: 'spectator',
      });
      expect((await games.chatHistory(guest, id)).map((m) => m.text)).toEqual([
        'Hello @alice',
        'Judge here',
      ]);
      expect(rec.sent.get('c-guest')?.filter((m) => m.type === 'chat')).toHaveLength(2);
    });
  });

  describe('commands', () => {
    it('applies commands and answers with the caller’s projection', async () => {
      const { games } = service(store, recordingGateway().gateway);
      const { id, seatOf } = await startedGame(games);
      const res = await games.command(alice, id, cmd({ type: 'Draw', from: 'crypt', count: 4 }));
      expect(res.events).toHaveLength(1);
      const drawn = res.events[0] as Extract<GameEvent, { type: 'CardsDrawn' }>;
      expect(drawn.cards.every((c) => c.cardId === 't-vera')).toBe(true);
      const bobView = (await games.details(bob, id)).view;
      const zone = bobView?.zones[`${seatOf(alice)}:uncontrolled`] ?? [];
      // The 4 dealt at the start, plus the 4 just drawn.
      expect(zone).toHaveLength(8);
      expect(zone.every((c) => bobView?.cards[c]?.cardId === undefined)).toBe(true);
      await expect(games.command(dave, id, cmd({ type: 'AdvancePhase' }))).rejects.toMatchObject({
        code: 'not_playing',
      });
      await expect(games.command(guest, id, cmd({ type: 'AdvancePhase' }))).rejects.toMatchObject({
        status: 401,
      });
      await expect(
        games.command(bob, id, cmd({ type: 'Draw', seat: seatOf(alice) })),
      ).rejects.toMatchObject({ status: 422, code: 'forbidden' });
    });

    it('applies a retried command once (idempotency)', async () => {
      const { games } = service(store, recordingGateway().gateway);
      const { id } = await startedGame(games);
      const request = cmd({ type: 'Draw', count: 2 });
      const first = await games.command(alice, id, request);
      const again = await games.command(alice, id, request);
      expect(again).toEqual(first);
      const { seq } = await games.canView(alice, id);
      expect(seq).toBe(first.seq);
      await expect(games.command(bob, id, request)).rejects.toMatchObject({
        code: 'duplicate_command',
      });
    });

    it('rejects a stale expectedSeq', async () => {
      const { games } = service(store, recordingGateway().gateway);
      const { id, seatOf } = await startedGame(games);
      await expect(
        games.command(
          alice,
          id,
          cmd({ type: 'AdjustPool', seat: seatOf(alice), delta: -1 }, { expectedSeq: 0 }),
        ),
      ).rejects.toMatchObject({ code: 'stale' });
    });

    it('serialises concurrent commands from separate Lambdas without losing updates (NFR-04)', async () => {
      const shared = recordingGateway().gateway;
      const lambdas = [1, 2, 3].map((seed) => service(store, shared, seed).games);
      const { id, seatOf } = await startedGame(lambdas[0] as GameService);
      const players = [alice, bob, carol];
      const results = await Promise.allSettled(
        Array.from({ length: 9 }, (_, i) =>
          (lambdas[i % 3] as GameService).command(
            players[i % 3] as Identity,
            id,
            cmd({ type: 'AdjustPool', seat: seatOf(players[i % 3] as Identity), delta: -1 }),
          ),
        ),
      );
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      for (const r of results)
        if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'busy' });
      expect(ok).toBeGreaterThanOrEqual(3);
      const view = (await service(store, shared, 9).games.details(judge, id)).view as GameState;
      const spent = view.seats.reduce((sum, s) => sum + (30 - s.pool), 0);
      expect(spent).toBe(ok);
      expect(view.seq).toBe(1 + ok);
    });
  });

  describe('catch-up and snapshots', () => {
    it('lets every viewer rebuild their view from projected events', async () => {
      const { games } = service(store, recordingGateway().gateway);
      const { id, seatOf } = await startedGame(games);
      for (const p of [alice, bob, carol]) {
        await games.command(p, id, cmd({ type: 'Draw', from: 'crypt', count: 4 }));
        await games.command(p, id, cmd({ type: 'Draw', count: 7 }));
      }
      await games.command(bob, id, cmd({ type: 'Shuffle', zone: `${seatOf(bob)}:library` }));
      for (const viewer of [alice, bob, judge, guest]) {
        const { view } = await games.details(viewer, id);
        const as = viewerOf(viewer, view as GameState);
        const { events } = await games.events(viewer, id, 0);
        const rebuilt = events.reduce(
          (v: GameState, ev) => project(evolve(v, ev), as),
          newGame(id),
        );
        expect(rebuilt).toEqual(view);
      }
      const tail = await games.events(alice, id, 3);
      expect(tail.events[0]?.seq).toBe(4);
    });

    it('snapshots every 25 events, and a cold Lambda loads the same state', async () => {
      const { games } = service(store, recordingGateway().gateway);
      const { id, seatOf } = await startedGame(games);
      for (let i = 0; i < 30; i++) {
        await games.command(
          alice,
          id,
          cmd({ type: 'AdjustPool', seat: seatOf(alice), delta: i % 2 ? 1 : -1 }),
        );
      }
      expect((await store.snapshot(id))?.seq).toBe(25);
      const cold = service(store, recordingGateway().gateway, 7).games;
      expect((await cold.details(judge, id)).view).toEqual((await games.details(judge, id)).view);
      const page = await cold.events(guest, id, 20);
      expect(page.events.map((e) => e.seq)).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
    });
  });

  describe('realtime', () => {
    it('pushes each subscriber their own projection and drops gone connections', async () => {
      const rec = recordingGateway();
      const { games, realtime } = service(store, rec.gateway);
      const { id } = await startedGame(games, 'private');
      await realtime.connect('c-bob', bob);
      await realtime.connect('c-dave', dave);
      await realtime.connect('c-judge', judge);
      for (const c of ['c-bob', 'c-dave', 'c-judge']) {
        await realtime.message(c, JSON.stringify({ type: 'subscribe', gameId: id }));
      }
      expect(rec.sent.get('c-bob')?.[0]).toEqual({ type: 'subscribed', gameId: id, seq: 1 });
      expect(rec.sent.get('c-dave')).toEqual([{ type: 'error', message: 'No such game' }]);

      await games.command(alice, id, cmd({ type: 'Draw', count: 3 }));
      const pushed = (c: string) => pushedEvents(rec.sent.get(c));
      const bobSees = pushed('c-bob')[0]?.events[0] as Extract<GameEvent, { type: 'CardsDrawn' }>;
      expect(bobSees.cards.map((c) => c.cardId)).toEqual([undefined, undefined, undefined]);
      expect(pushed('c-judge')).toHaveLength(1);
      expect(pushed('c-dave')).toHaveLength(0);

      rec.gone.add('c-bob');
      await games.command(judge, id, cmd({ type: 'AdvancePhase' }));
      expect(await store.getConnection('c-bob')).toBeUndefined();
      expect((await store.subscribers(id)).map((s) => s.connectionId)).toEqual(['c-judge']);

      await realtime.message('c-judge', '{"type":"ping"}');
      await realtime.message('c-judge', 'nonsense');
      expect(rec.sent.get('c-judge')?.slice(-2)).toEqual([
        { type: 'pong' },
        { type: 'error', message: 'Unrecognised message' },
      ]);
      await realtime.disconnect('c-judge');
      expect(await store.subscribers(id)).toEqual([]);
    });

    it('admins can replace a player in a casual game', async () => {
      const { games } = service(store, recordingGateway().gateway);
      const { id, seatOf } = await startedGame(games);
      const seat = seatOf(carol);
      await expect(
        games.command(alice, id, cmd({ type: 'ReplacePlayer', seat, user: 'dave' })),
      ).rejects.toMatchObject({ status: 403 });
      await games.command(admin, id, cmd({ type: 'ReplacePlayer', seat, user: 'dave' }));
      expect((await games.details(dave, id)).seat).toBe(seat);
      await expect(games.command(carol, id, cmd({ type: 'AdvancePhase' }))).rejects.toMatchObject({
        code: 'not_playing',
      });
    });
  });

  describe('presence (TEMPO-06)', () => {
    const presence = async (games: GameService, id: string) =>
      Object.fromEntries(
        (await games.details(judge, id)).view?.seats.map((s) => [s.occupant, !!s.present]) ?? [],
      );

    it('marks players present on arrival and away once they have been gone a while', async () => {
      const rec = recordingGateway();
      const manual = manualTimers();
      const { games, realtime } = service(store, rec.gateway, 1, manual.timers);
      const g = await games.create(alice, {
        name: 'Presence',
        format: 'standard',
        visibility: 'public',
        maxSeats: 3,
      });
      for (const p of [alice, bob, carol]) await games.join(p, g.id, { deck });
      // Alice watches the lobby, so she is at the table as soon as the game starts.
      await realtime.connect('p-alice', alice);
      await realtime.message('p-alice', JSON.stringify({ type: 'subscribe', gameId: g.id }));
      await games.start(alice, g.id);
      expect(await presence(games, g.id)).toEqual({ alice: true, bob: false, carol: false });

      await realtime.connect('p-bob', bob);
      await realtime.message('p-bob', JSON.stringify({ type: 'subscribe', gameId: g.id }));
      await realtime.connect('p-bob2', bob);
      await realtime.message('p-bob2', JSON.stringify({ type: 'subscribe', gameId: g.id }));
      expect(await presence(games, g.id)).toMatchObject({ bob: true });
      // Arrival was pushed to the others; spectators are counted, players aren't.
      const aliceGot = rec.sent.get('p-alice') ?? [];
      expect(
        aliceGot.some((m) => m.type === 'events' && m.events[0]?.type === 'PlayerPresent'),
      ).toBe(true);
      await realtime.connect('p-dave', dave);
      await realtime.message('p-dave', JSON.stringify({ type: 'subscribe', gameId: g.id }));
      expect(rec.sent.get('p-alice')?.at(-1)).toEqual({
        type: 'audience',
        gameId: g.id,
        spectators: 1,
      });

      // Bob closes one tab: the check finds his other one and leaves him present.
      const key = presenceKey(g.id, 'bob');
      await realtime.disconnect('p-bob');
      expect(manual.scheduled.get(key)).toEqual({
        at: new Date(Date.parse('2026-11-05T10:00:00Z') + ABSENCE_DELAY_MS),
        payload: { kind: 'presence', gameId: g.id, user: 'bob' },
      });
      await games.checkAbsence(g.id, 'bob');
      expect(await presence(games, g.id)).toMatchObject({ bob: true });

      // Bob closes the other one too and stays gone: away.
      await realtime.disconnect('p-bob2');
      await games.checkAbsence(g.id, 'bob');
      expect(await presence(games, g.id)).toMatchObject({ bob: false });
      // A spectator leaving schedules nothing.
      manual.scheduled.clear();
      await realtime.disconnect('p-dave');
      expect(manual.scheduled.size).toBe(0);
      expect(rec.sent.get('p-alice')?.at(-1)).toMatchObject({ type: 'audience', spectators: 0 });

      // Presence is bookkeeping: none of it reaches the log as a command anyone made.
      const { events } = await games.events(alice, g.id, 0);
      expect(
        events.filter((e) => e.type === 'PlayerPresent' || e.type === 'PlayerAbsent'),
      ).toSatisfy((es: GameEvent[]) => es.every((e) => e.by.kind === 'system'));
    });

    it('does nothing when switched off', async () => {
      const rec = recordingGateway();
      const manual = manualTimers();
      const { games, realtime } = service(store, rec.gateway, 1, manual.timers, false);
      const { id } = await startedGame(games);
      await realtime.connect('off-bob', bob);
      await realtime.message('off-bob', JSON.stringify({ type: 'subscribe', gameId: id }));
      await realtime.disconnect('off-bob');
      await games.checkAbsence(id, 'bob');
      expect(await presence(games, id)).toEqual({ alice: false, bob: false, carol: false });
      expect(manual.scheduled.size).toBe(0);
      expect(rec.sent.get('off-bob')).toEqual([{ type: 'subscribed', gameId: id, seq: 1 }]);
    });

    it('ignores players who came back, and games that are not in progress', async () => {
      const manual = manualTimers();
      const { games, realtime } = service(store, recordingGateway().gateway, 1, manual.timers);
      const { id } = await startedGame(games);
      await realtime.connect('q-carol', carol);
      await realtime.message('q-carol', JSON.stringify({ type: 'subscribe', gameId: id }));
      await realtime.message('q-carol', JSON.stringify({ type: 'unsubscribe', gameId: id }));
      expect(manual.scheduled.has(presenceKey(id, 'carol'))).toBe(true);
      // A reload: back before the check runs.
      await realtime.message('q-carol', JSON.stringify({ type: 'subscribe', gameId: id }));
      const seq = (await games.details(carol, id)).game.seq;
      await games.checkAbsence(id, 'carol');
      expect((await games.details(carol, id)).game.seq).toBe(seq);
      expect(await presence(games, id)).toMatchObject({ carol: true });

      const open = await games.create(alice, {
        name: 'Lobby',
        format: 'standard',
        visibility: 'public',
        maxSeats: 3,
      });
      await expect(games.setPresence(open.id, 'alice', true)).resolves.toBeUndefined();
      expect((await games.details(alice, open.id)).game.seq).toBe(0);
    });
  });
});
