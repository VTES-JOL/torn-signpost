import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { seededRng } from '@torn-signpost/engine';
import type { ServerMessage } from '@torn-signpost/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Identity } from '../auth.ts';
import { NotificationStore } from '../db/notifications.ts';
import type { GameStore } from '../db/store.ts';
import { GameService } from '../games/service.ts';
import type { ConnectionGateway } from '../realtime/gateway.ts';
import { Fanout, Realtime } from '../realtime/realtime.ts';
import { testContent, testDeck } from '../testing/content.ts';
import { dynamoAvailable, testStore } from '../testing/dynamo.ts';
import { NotificationService } from './service.ts';

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
const jo = user('jo', ['judge']);

let n = 0;
let clock = Date.parse('2026-11-05T10:00:00Z');
const now = () => {
  clock += 1000;
  return new Date(clock);
};

describe.skipIf(!available)('notifications (DynamoDB Local)', () => {
  let store: GameStore;
  let db: DynamoDBDocumentClient;
  let tableName: string;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ store, db, tableName, cleanup } = await testStore()));
  afterAll(() => cleanup?.());

  function setup() {
    const sent = new Map<string, ServerMessage[]>();
    const gateway: ConnectionGateway = {
      async post(id, message) {
        sent.set(id, [...(sent.get(id) ?? []), message]);
        return true;
      },
    };
    const notifications = new NotificationService({
      store: new NotificationStore(db, tableName),
      games: store,
      gateway,
      newId: () => `n${++n}`,
      now,
    });
    const games = new GameService({
      store,
      content: testContent,
      rng: seededRng(3),
      publisher: new Fanout(store, gateway),
      newId: () => `g${++n}`,
      now,
      notifier: notifications,
    });
    const realtime = new Realtime(store, gateway, games, { notifications });
    const pushed = (conn: string) =>
      (sent.get(conn) ?? []).flatMap((m) => (m.type === 'notification' ? [m.notification] : []));
    return { games, notifications, realtime, pushed };
  }

  async function startedGame(games: GameService) {
    const g = await games.create(alice, {
      name: 'Notified',
      format: 'standard',
      visibility: 'public',
      maxSeats: 3,
    });
    for (const p of [alice, bob, carol]) await games.join(p, g.id, { deck: testDeck });
    await games.start(alice, g.id);
    return g.id;
  }

  it('stores notifications and pushes them to every connection the user has', async () => {
    const { games, notifications, realtime, pushed } = setup();
    // Bob has the site open twice, neither on the game.
    await realtime.connect('bob-1', bob);
    await realtime.connect('bob-2', bob);
    const id = await startedGame(games);

    // Started, and perhaps Bob's turn or first decision, depending on the seating.
    for (const conn of ['bob-1', 'bob-2']) {
      expect(pushed(conn)).toContainEqual(
        expect.objectContaining({ kind: 'started', gameId: id, gameName: 'Notified', read: false }),
      );
    }
    const before = pushed('bob-2').length;
    const list = await notifications.list(bob);
    expect(list.items.map((i) => i.kind)).toContain('started');
    expect(list.unread).toBeGreaterThan(0);
    // The player who started it isn't told.
    expect((await notifications.list(alice)).items.some((i) => i.gameId === id)).toBe(false);

    // A closed connection stops getting them.
    await realtime.disconnect('bob-2');
    await games.chat(alice, id, { text: 'hi @bob' });
    expect(pushed('bob-1').at(-1)).toMatchObject({
      kind: 'mention',
      text: 'alice mentioned you: “hi @bob”',
    });
    expect(pushed('bob-2')).toHaveLength(before);
  });

  it('tells judges who have connected about judge calls', async () => {
    const { games, notifications, realtime } = setup();
    await realtime.connect('jo-1', jo);
    const id = await startedGame(games);
    await games.command(bob, id, {
      commandId: `call-${Date.now()}`,
      command: { type: 'CallJudge', reason: 'rules', note: 'Can I?' },
    });
    const list = await notifications.list(jo);
    expect(list.items[0]).toMatchObject({
      kind: 'judge-call',
      gameId: id,
      text: 'Judge call: a rules question',
    });
  });

  it('marks notifications read, one by one or all, and pages through them', async () => {
    const { games, notifications } = setup();
    for (let i = 0; i < 3; i++) await startedGame(games);
    const first = await notifications.list(carol);
    const mine = first.items.filter((i) => !i.read);
    expect(mine.length).toBeGreaterThanOrEqual(3);
    const before = first.unread;

    const one = mine[0]?.id ?? '';
    expect((await notifications.markRead(carol, { ids: [one] })).unread).toBe(before - 1);
    expect((await notifications.list(carol)).items.find((i) => i.id === one)?.read).toBe(true);
    // Someone else's ID does nothing.
    expect(
      (await notifications.markRead(bob, { ids: [mine[1]?.id ?? ''] })).unread,
    ).toBeGreaterThan(0);
    expect((await notifications.markRead(carol, { all: true })).unread).toBe(0);

    // Newest first; `before` continues after the given ID.
    const ids = (await notifications.list(carol)).items.map((i) => i.id);
    expect([...ids].sort().reverse()).toEqual(ids);
    const rest = await notifications.list(carol, ids[0]);
    expect(rest.items[0]?.id).toBe(ids[1]);
  });
});
