import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DEFAULT_EMAIL_PREFS, type Notification } from '@torn-signpost/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Identity } from '../auth.ts';
import { EmailStore } from '../db/email.ts';
import { NotificationStore } from '../db/notifications.ts';
import type { GameStore } from '../db/store.ts';
import { dynamoAvailable, testStore } from '../testing/dynamo.ts';
import type { TimerPayload, Timers } from '../timers/timers.ts';
import type { Email } from './mailer.ts';
import { EMAIL_DELAY_MS, EmailService, IDLE_MS } from './service.ts';

const available = await dynamoAvailable();

let n = 0;
const at = '2026-11-05T10:00:00.000Z';
const notification = (kind: Notification['kind'], extra: Partial<Notification> = {}) => {
  const id = `${at}_n${++n}`;
  return {
    id,
    kind,
    gameId: 'g1',
    gameName: 'Night <Court>',
    text: kind === 'deadline' ? 'Half your time to decide has gone' : 'Your turn (turn 3)',
    at,
    seq: 10,
    read: false,
    ...extra,
  } satisfies Notification;
};

describe.skipIf(!available)('email notifications (DynamoDB Local)', () => {
  let games: GameStore;
  let db: DynamoDBDocumentClient;
  let tableName: string;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ store: games, db, tableName, cleanup } = await testStore()));
  afterAll(() => cleanup?.());

  let clock = new Date(at);

  function setup() {
    clock = new Date(at);
    const sent: Email[] = [];
    const scheduled = new Map<string, { at: Date; payload: TimerPayload }>();
    const timers: Timers = {
      async schedule(key, when, payload) {
        scheduled.set(key, { at: when, payload });
      },
      async cancel(key) {
        scheduled.delete(key);
      },
    };
    const store = new EmailStore(db, tableName);
    const notifications = new NotificationStore(db, tableName);
    const email = new EmailService({
      store,
      notifications,
      games,
      mailer: { send: async (e) => void sent.push(e) },
      timers,
      secret: async () => 'test-secret',
      webUrl: 'https://web.example',
      apiUrl: 'https://api.example',
      now: () => clock,
    });
    /** A new user with an address on file, and a notification sent to them. */
    const player = async (name: string) => {
      const sub = `${name}-${++n}`;
      const identity: Identity = {
        kind: 'user',
        sub,
        name,
        groups: [],
        email: `${name}@mail.example`,
      };
      await email.seen(identity);
      return { sub, identity };
    };
    const notify = async (user: string, x: Notification) => {
      await notifications.put(user, x);
      await email.notified(user, x);
    };
    return { email, store, notifications, sent, scheduled, player, notify };
  }

  it('emails deadlines after a delay, only if still unread and the player is away', async () => {
    const { email, notifications, sent, scheduled, player, notify } = setup();
    const { sub, identity } = await player('ana');
    const due = notification('deadline');
    await notify(sub, due);
    const timer = scheduled.get(`email:${sub}:${due.id}`);
    expect(timer?.at.getTime()).toBe(Date.parse(at) + EMAIL_DELAY_MS);
    expect(timer?.payload).toEqual({ kind: 'email', user: sub, id: due.id });

    await email.sendNow(sub, due.id);
    expect(sent).toHaveLength(1);
    const mail = sent[0];
    expect(mail?.to).toBe('ana@mail.example');
    expect(mail?.subject).toBe('Half your time to decide has gone · Night <Court>');
    expect(mail?.text).toContain('https://web.example/games/g1');
    expect(mail?.html).toContain('Night &lt;Court&gt;');
    expect(mail?.headers['List-Unsubscribe']).toMatch(
      /^<https:\/\/api\.example\/email\/unsubscribe\?u=.+&c=deadline&t=.+>$/,
    );
    expect(mail?.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

    // Read in the meantime: nothing.
    const read = notification('deadline');
    await notify(sub, read);
    await notifications.markRead(sub, [read.id]);
    await email.sendNow(sub, read.id);
    // On the site and using it in the meantime: nothing.
    const seen = notification('deadline');
    await notify(sub, seen);
    await games.putConnection(`c-${sub}`, { kind: 'user', sub, name: 'ana', groups: [] });
    await email.active(identity);
    await email.sendNow(sub, seen.id);
    expect(sent).toHaveLength(1);

    // A tab left open but unused for a while doesn't count: the email goes out.
    clock = new Date(Date.parse(at) + IDLE_MS + 60_000);
    await email.sendNow(sub, seen.id);
    expect(sent).toHaveLength(2);
  });

  it('collects the rest for the digest: 17:00 for daily, 05:00 and 17:00 for twice daily, local time', async () => {
    const { email, store, notifications, sent, scheduled, player, notify } = setup();
    const daily = await player('dee');
    const twice = await player('tom');
    await store.putPrefs(twice.sub, { ...DEFAULT_EMAIL_PREFS, digest: 'twice-daily' });
    const a = notification('turn');
    const b = notification('turn', { gameId: 'g2', gameName: 'Elysium' });
    const c = notification('turn');
    for (const x of [a, b, c]) await notify(daily.sub, x);
    await notifications.markRead(daily.sub, [c.id]);
    await notify(twice.sub, notification('turn'));
    expect(scheduled.size).toBe(0);

    // 05:00 UTC: only twice daily.
    await email.digest(new Date('2026-11-05T05:00:00Z'));
    expect(sent.map((m) => m.to)).toEqual(['tom@mail.example']);

    await email.digest(new Date('2026-11-05T17:05:00Z'));
    const mail = sent.find((m) => m.to === 'dee@mail.example');
    expect(sent).toHaveLength(2);
    // Two unread, in two games; the read one is left out.
    expect(mail?.subject).toBe('2 things waiting for you on Torn Signpost');
    expect(mail?.text).toContain('Night <Court> (https://web.example/games/g1)');
    expect(mail?.text).toContain('Elysium (https://web.example/games/g2)');
    expect(mail?.headers['List-Unsubscribe']).toContain('c=all');

    // The queue is cleared once sent.
    await email.digest(new Date('2026-11-05T17:05:00Z'));
    expect(sent).toHaveLength(2);
  });

  it('sends the digest at 17:00 in the user’s own time zone', async () => {
    const { email, store, sent, player, notify } = setup();
    const { sub } = await player('kai');
    await store.putPrefs(sub, { ...DEFAULT_EMAIL_PREFS, timeZone: 'America/New_York' });
    await notify(sub, notification('turn'));
    // 17:00 UTC is noon in New York (EST, November): not yet.
    await email.digest(new Date('2026-11-05T17:00:00Z'));
    expect(sent).toHaveLength(0);
    // 22:00 UTC is 17:00 there.
    await email.digest(new Date('2026-11-05T22:00:00Z'));
    expect(sent.map((m) => m.to)).toEqual(['kai@mail.example']);
  });

  it('turns email off from a signed link, and refuses a forged one', async () => {
    const { email, store, sent, scheduled, player, notify } = setup();
    const { sub, identity } = await player('una');
    await notify(sub, notification('deadline'));
    const [timer] = [...scheduled.values()];
    if (timer?.payload.kind === 'email') await email.sendNow(sub, timer.payload.id);
    const link = new URL((sent[0]?.headers['List-Unsubscribe'] ?? '').replace(/^<|>$/g, ''))
      .searchParams;
    const req = { u: link.get('u') ?? '', c: 'deadline' as const, t: link.get('t') ?? '' };

    await expect(email.unsubscribe({ ...req, c: 'all' })).rejects.toMatchObject({ status: 403 });
    await expect(email.unsubscribe({ ...req, t: `${req.t.slice(0, -2)}xx` })).rejects.toMatchObject(
      { status: 403 },
    );
    await email.unsubscribe(req);
    const settings = await email.settings(identity);
    expect(settings.address).toBe('una@mail.example');
    expect(settings.prefs.modes.deadline).toBe('off');
    expect(settings.prefs.modes.judge).toBe('immediate');

    // Off means not even scheduled.
    scheduled.clear();
    await notify(sub, notification('deadline'));
    expect(scheduled.size).toBe(0);
    expect(await store.prefs(sub)).toMatchObject({ digest: 'daily' });
  });
});
