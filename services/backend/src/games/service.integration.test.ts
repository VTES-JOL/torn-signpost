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
import { Fanout, Realtime } from '../realtime/realtime.ts';
import { testContent, testDeck } from '../testing/content.ts';
import { dynamoAvailable, testStore } from '../testing/dynamo.ts';
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

let n = 0;
function service(store: GameStore, gateway: ConnectionGateway, seed = 1) {
  const games = new GameService({
    store,
    content: testContent,
    rng: seededRng(seed),
    publisher: new Fanout(store, gateway),
    newId: () => `g${++n}-${seed}`,
  });
  return { games, realtime: new Realtime(store, gateway, games) };
}

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
      expect(zone).toHaveLength(4);
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
      expect(rec.sent.get('c-bob')).toEqual([{ type: 'subscribed', gameId: id, seq: 1 }]);
      expect(rec.sent.get('c-dave')).toEqual([{ type: 'error', message: 'No such game' }]);

      await games.command(alice, id, cmd({ type: 'Draw', count: 3 }));
      const pushed = (c: string) =>
        (rec.sent.get(c) ?? []).filter(
          (m): m is Extract<ServerMessage, { type: 'events' }> => m.type === 'events',
        );
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
});
