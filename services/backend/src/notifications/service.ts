/**
 * In-app notifications (NOTIF-01): stored for 30 days and pushed to every connection the user has
 * open. Sending never fails a command: errors are logged.
 */
import { type GameEvent, type GameState, waitingOn } from '@torn-signpost/engine';
import {
  type MarkReadRequest,
  type Notification,
  type NotificationsResponse,
  UNREAD_CAP,
} from '@torn-signpost/protocol';
import type { Identity } from '../auth.ts';
import type { NotificationStore } from '../db/notifications.ts';
import type { GameStore } from '../db/store.ts';
import type { EmailService } from '../email/service.ts';
import { ApiError } from '../errors.ts';
import type { ConnectionGateway } from '../realtime/gateway.ts';
import { type Draft, gameNotifications, mentioned } from './triggers.ts';

const PAGE = 20;
/** Notifications about a wait, which are done once the wait is. */
const WAIT_KINDS = ['turn', 'decision', 'deadline'] as const;

/** What the game service tells the notifier; implemented by `NotificationService`. */
export interface Notifier {
  afterCommand(input: {
    game: { id: string; name: string };
    before: GameState;
    after: GameState;
    events: readonly GameEvent[];
    actor?: string | undefined;
  }): Promise<void>;
  chat(input: {
    game: { id: string; name: string; seq: number };
    text: string;
    author: string;
    authorName: string;
    people: readonly { user: string; name: string }[];
  }): Promise<void>;
}

export class NotificationService implements Notifier {
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      store: NotificationStore;
      games: GameStore;
      gateway: ConnectionGateway;
      newId: () => string;
      /** Email for players who want it (NOTIF-02). */
      email?: Pick<EmailService, 'notified'>;
      now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  async afterCommand(input: Parameters<Notifier['afterCommand']>[0]): Promise<void> {
    try {
      const judges = input.events.some((e) => e.type === 'JudgeCalled')
        ? await this.deps.store.staff('judge')
        : [];
      const admins = input.events.some(isEscalation) ? await this.deps.store.staff('admin') : [];
      const drafts = gameNotifications({ ...input, judges, admins });
      await this.send(input.game, input.after.seq, drafts);
      // A turn or decision that no longer waits on someone is done: it shouldn't be emailed.
      const waiting = new Set(waitingOn(input.after).map((w) => w.seat));
      const done = new Set(
        waitingOn(input.before)
          .filter((w) => !waiting.has(w.seat))
          .flatMap((w) => input.after.seats.find((s) => s.id === w.seat)?.occupant ?? []),
      );
      for (const user of done) await this.readGame(user, input.game.id, WAIT_KINDS);
    } catch (e) {
      console.error('notifications failed', { gameId: input.game.id, error: String(e) });
    }
  }

  async chat(input: Parameters<Notifier['chat']>[0]): Promise<void> {
    try {
      const text = `${input.authorName} mentioned you: “${clip(input.text, 120)}”`;
      const drafts = mentioned(input.text, input.people, input.author).map(
        (user): Draft => ({ user, kind: 'mention', text }),
      );
      await this.send(input.game, input.game.seq, drafts);
    } catch (e) {
      console.error('notifications failed', { gameId: input.game.id, error: String(e) });
    }
  }

  /** The user opened a game: everything they were told about it is seen. */
  async openedGame(identity: Identity, gameId: string): Promise<void> {
    if (identity.kind !== 'user') return;
    try {
      await this.readGame(identity.sub, gameId);
    } catch (e) {
      console.warn('marking notifications read failed', { gameId, error: String(e) });
    }
  }

  private async readGame(user: string, gameId: string, kinds?: readonly string[]) {
    const ids = await this.deps.store.unreadFor(user, gameId, UNREAD_CAP, kinds);
    if (!ids.length) return;
    await this.deps.store.markRead(user, ids);
    const unread = await this.deps.store.unread(user, UNREAD_CAP);
    for (const connectionId of await this.deps.games.userConnections(user)) {
      try {
        await this.deps.gateway.post(connectionId, { type: 'notifications-read', ids, unread });
      } catch (e) {
        console.warn('notification push failed', { connectionId, error: String(e) });
      }
    }
  }

  /**
   * A judge or admin connected: judge calls reach judges, and escalations admins, who have been
   * around in the last 30 days.
   */
  async seen(identity: Identity): Promise<void> {
    if (identity.kind !== 'user') return;
    try {
      for (const role of ['judge', 'admin'] as const) {
        if (identity.groups.includes(role)) await this.deps.store.putStaff(role, identity.sub);
      }
    } catch (e) {
      console.warn('staff registry failed', { error: String(e) });
    }
  }

  async list(identity: Identity, before?: string): Promise<NotificationsResponse> {
    const user = requireUser(identity);
    const [page, unread] = await Promise.all([
      this.deps.store.list(user, { limit: PAGE, ...(before ? { before } : {}) }),
      this.deps.store.unread(user, UNREAD_CAP),
    ]);
    const last = page.items.at(-1);
    return { items: page.items, unread, ...(page.more && last ? { next: last.id } : {}) };
  }

  async markRead(identity: Identity, req: MarkReadRequest): Promise<{ unread: number }> {
    const user = requireUser(identity);
    const ids = 'ids' in req ? req.ids : await this.deps.store.unreadIds(user, UNREAD_CAP);
    await this.deps.store.markRead(user, ids);
    return { unread: await this.deps.store.unread(user, UNREAD_CAP) };
  }

  private async send(
    game: { id: string; name: string },
    seq: number,
    drafts: readonly Draft[],
  ): Promise<void> {
    const at = this.now().toISOString();
    await Promise.all(
      drafts.map(async (d) => {
        const notification: Notification = {
          // Time first, so IDs sort by when they were sent.
          id: `${at}_${this.deps.newId()}`,
          kind: d.kind,
          gameId: game.id,
          gameName: game.name,
          text: d.text,
          at,
          seq,
          read: false,
        };
        await this.deps.store.put(d.user, notification);
        await this.push(d.user, notification);
        await this.deps.email?.notified(d.user, notification);
      }),
    );
  }

  private async push(user: string, notification: Notification): Promise<void> {
    for (const connectionId of await this.deps.games.userConnections(user)) {
      try {
        if (!(await this.deps.gateway.post(connectionId, { type: 'notification', notification }))) {
          await this.deps.games.deleteConnection(connectionId);
        }
      } catch (e) {
        console.warn('notification push failed', { connectionId, error: String(e) });
      }
    }
  }
}

const isEscalation = (e: GameEvent) =>
  e.type === 'JudgeCallResolved' && e.ruling.kind === 'escalate';

function requireUser(identity: Identity): string {
  if (identity.kind !== 'user') throw new ApiError(401, 'unauthenticated', 'Sign in first');
  return identity.sub;
}

function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}
