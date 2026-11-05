/**
 * In-app notifications (NOTIF-01): stored for 30 days and pushed to every connection the user has
 * open. Sending never fails a command: errors are logged.
 */
import type { GameEvent, GameState } from '@torn-signpost/engine';
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
        ? await this.deps.store.judges()
        : [];
      const drafts = gameNotifications({ ...input, judges });
      await this.send(input.game, input.after.seq, drafts);
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

  /** A judge connected: judge calls reach judges who have been around in the last 30 days. */
  async seen(identity: Identity): Promise<void> {
    if (identity.kind !== 'user' || !identity.groups.includes('judge')) return;
    try {
      await this.deps.store.putJudge(identity.sub);
    } catch (e) {
      console.warn('judge registry failed', { error: String(e) });
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

function requireUser(identity: Identity): string {
  if (identity.kind !== 'user') throw new ApiError(401, 'unauthenticated', 'Sign in first');
  return identity.sub;
}

function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}
