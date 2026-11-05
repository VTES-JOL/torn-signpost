import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { seededRng, waitingOn } from '@torn-signpost/engine';
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
const ada = user('ada', ['admin']);

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
    const read = (conn: string) =>
      (sent.get(conn) ?? []).flatMap((m) => (m.type === 'notifications-read' ? [m] : []));
    return { games, notifications, realtime, pushed, read };
  }

  async function startedGame(games: GameService, starter: Identity = alice) {
    const g = await games.create(alice, {
      name: 'Notified',
      format: 'standard',
      visibility: 'public',
      maxSeats: 3,
    });
    for (const p of [alice, bob, carol]) await games.join(p, g.id, { deck: testDeck });
    await games.start(starter, g.id);
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

  it('marks a game read when the player opens it, and tells their other connections', async () => {
    const { games, notifications, realtime, read } = setup();
    await realtime.connect('carol-1', carol);
    const id = await startedGame(games);
    expect((await notifications.list(carol)).items.some((i) => i.gameId === id && !i.read)).toBe(
      true,
    );
    await realtime.connect('carol-2', carol);
    await realtime.message('carol-2', JSON.stringify({ type: 'subscribe', gameId: id }));
    const mine = (await notifications.list(carol)).items.filter((i) => i.gameId === id);
    expect(mine.every((i) => i.read)).toBe(true);
    expect(read('carol-1').at(-1)?.ids.sort()).toEqual(mine.map((i) => i.id).sort());
  });

  it('marks a turn or decision read once the game stops waiting on that player', async () => {
    const { games, notifications } = setup();
    // Started by an admin, so the first player is told it's their turn whoever they are.
    const id = await startedGame(games, ada);
    const view = await games.details(alice, id);
    const seat = view.view?.turn?.seat;
    const player = [alice, bob, carol].find(
      (p) => p.kind === 'user' && view.view?.seats.find((s) => s.id === seat)?.occupant === p.sub,
    );
    if (player?.kind !== 'user') throw new Error('no first player');
    const turn = (await notifications.list(player)).items.find(
      (i) => i.gameId === id && (i.kind === 'turn' || i.kind === 'decision'),
    );
    if (!turn) throw new Error('the first player was not told');
    expect(turn.read).toBe(false);
    await games.command(player, id, {
      commandId: `adv-${Date.now()}`,
      command: { type: 'AdvancePhase' },
    });
    // Still their turn (a new phase), so the turn notification stays until the turn is over.
    for (let i = 0; i < 12; i++) {
      const d = await games.details(alice, id);
      if (d.view?.turn?.seat !== seat) break;
      const waits = d.view ? waitingOn(d.view) : [];
      const w = waits[0];
      const who = [alice, bob, carol].find(
        (p) => p.kind === 'user' && d.view?.seats.find((s) => s.id === w?.seat)?.occupant === p.sub,
      );
      if (!who) break;
      await games.command(who, id, {
        commandId: `step-${i}-${Date.now()}`,
        command: { type: w?.kind === 'phase' ? 'AdvancePhase' : 'Pass' },
      });
    }
    const after = (await notifications.list(player)).items.find((i) => i.id === turn.id);
    expect(after?.read).toBe(true);
  });

  it('puts escalations in the admin queue, tells admins, and lets one replace the player', async () => {
    const { games, notifications, realtime } = setup();
    await realtime.connect('ada-1', ada);
    const id = await startedGame(games);
    await games.command(bob, id, {
      commandId: `call-${Date.now()}`,
      command: { type: 'CallJudge', reason: 'slow-play', note: 'Carol has gone' },
    });
    const details = await games.details(alice, id);
    const callId = details.view?.judgeCalls?.[0]?.id ?? '';
    const carolSeat = details.view?.seats.find((s) => s.occupant === 'carol')?.id ?? '';
    await games.command(jo, id, {
      commandId: `rule-${Date.now()}`,
      command: {
        type: 'ResolveJudgeCall',
        id: callId,
        ruling: { kind: 'escalate' },
        note: 'Please replace Carol',
      },
    });

    const queue = (await games.escalations(ada)).filter((e) => e.gameId === id);
    expect(queue).toEqual([
      expect.objectContaining({ gameName: 'Notified', judge: 'jo', note: 'Please replace Carol' }),
    ]);
    expect((await notifications.list(ada)).items[0]).toMatchObject({
      kind: 'escalation',
      gameId: id,
    });
    await expect(games.escalations(bob)).rejects.toMatchObject({ status: 403 });

    const byName = async (name: string) => (name === 'Dana' ? 'dana' : undefined);
    await expect(
      games.resolveEscalation(
        ada,
        id,
        callId,
        { replace: { seat: carolSeat, name: 'Nobody' } },
        byName,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await games.resolveEscalation(
      ada,
      id,
      callId,
      { replace: { seat: carolSeat, name: 'Dana' } },
      byName,
    );
    const after = await games.details(alice, id);
    expect(after.view?.seats.find((s) => s.id === carolSeat)?.occupant).toBe('dana');
    expect((await games.escalations(ada)).some((e) => e.gameId === id)).toBe(false);
  });

  it('moves a finished game to the finished list, and takes no more commands', async () => {
    const { games, notifications } = setup();
    const id = await startedGame(games);
    await expect(
      games.command(jo, id, { commandId: `end-j-${Date.now()}`, command: { type: 'EndGame' } }),
    ).rejects.toMatchObject({ status: 403 });
    await games.command(ada, id, {
      commandId: `end-${Date.now()}`,
      command: { type: 'EndGame', note: 'Closing time' },
    });
    expect((await games.list(alice, 'finished')).map((g) => g.id)).toContain(id);
    expect((await games.list(alice, 'active')).map((g) => g.id)).not.toContain(id);
    const d = await games.details(alice, id);
    expect(d.game.status).toBe('finished');
    expect(d.view?.result?.reason).toBe('admin');
    await expect(
      games.command(alice, id, {
        commandId: `late-${Date.now()}`,
        command: { type: 'AdvancePhase' },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await notifications.list(bob)).items[0]).toMatchObject({ kind: 'ended', gameId: id });
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
