/**
 * Email notifications (NOTIF-02, docs/m5b-plan.md increment 6). A notification someone wants by
 * email waits `EMAIL_DELAY_MS`, then goes out only if it is still unread and they have no
 * connection open: an active player never gets email. Digest notifications wait for the digest
 * run, which checks the same. Every email links to one-click unsubscribe.
 *
 * "Away" means no connection open, or none of them used for `IDLE_MS`: a tab left open in the
 * background doesn't stop email. Activity is a command or other change, opening a game, or the web
 * app reporting input; keepalive pings and polling don't count.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  EMAIL_CATEGORY,
  type EmailCategory,
  type EmailPrefs,
  type EmailSettings,
  type Notification,
  type UnsubscribeRequest,
} from '@torn-signpost/protocol';
import type { Identity } from '../auth.ts';
import type { EmailStore } from '../db/email.ts';
import type { NotificationStore } from '../db/notifications.ts';
import type { GameStore } from '../db/store.ts';
import { ApiError } from '../errors.ts';
import type { Timers } from '../timers/timers.ts';
import type { Email, Mailer } from './mailer.ts';

/** Long enough to cover a quick look away; short enough for a deadline to still matter. */
export const EMAIL_DELAY_MS = 2 * 60_000;
/** Connected but unused this long counts as away. */
export const IDLE_MS = 15 * 60_000;
/** Activity is recorded at most this often per user and process. */
const TOUCH_EVERY_MS = 60_000;

/** Digest runs: every one for twice-daily, the evening one for daily. */
export type DigestSlot = 'morning' | 'evening';

export interface EmailServiceDeps {
  store: EmailStore;
  notifications: NotificationStore;
  games: GameStore;
  mailer: Mailer;
  timers?: Timers;
  /** Signs unsubscribe links. */
  secret: () => Promise<string>;
  /** e.g. https://tornsignpost.org, for links in emails. */
  webUrl: string;
  /** e.g. https://api.tornsignpost.org, for one-click unsubscribe. */
  apiUrl: string;
  now?: () => Date;
}

export class EmailService {
  private readonly now: () => Date;
  /** Addresses already recorded by this process, so signing in costs one write per cold start. */
  private readonly known = new Map<string, string>();
  private readonly touched = new Map<string, number>();

  constructor(private readonly deps: EmailServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Keep the user's verified sign-in address on file. Never fails the request. */
  async seen(identity: Identity): Promise<void> {
    if (identity.kind !== 'user' || !identity.email) return;
    if (this.known.get(identity.sub) === identity.email) return;
    try {
      if ((await this.deps.store.address(identity.sub)) !== identity.email) {
        await this.deps.store.putAddress(identity.sub, identity.email);
      }
      this.known.set(identity.sub, identity.email);
    } catch (e) {
      console.warn('email address update failed', { error: String(e) });
    }
  }

  /** The user did something on the site. Never fails the request. */
  async active(identity: Identity): Promise<void> {
    if (identity.kind !== 'user') return;
    const now = this.now();
    if (now.getTime() - (this.touched.get(identity.sub) ?? 0) < TOUCH_EVERY_MS) return;
    this.touched.set(identity.sub, now.getTime());
    if (this.touched.size > 10_000) this.touched.clear();
    try {
      await this.deps.store.touch(identity.sub, now);
    } catch (e) {
      console.warn('activity update failed', { error: String(e) });
    }
  }

  async settings(identity: Identity): Promise<EmailSettings> {
    const user = requireUser(identity);
    const [address, prefs] = await Promise.all([
      this.deps.store.address(user),
      this.deps.store.prefs(user),
    ]);
    return { ...(address ? { address } : {}), prefs };
  }

  async savePrefs(identity: Identity, prefs: EmailPrefs): Promise<EmailSettings> {
    const user = requireUser(identity);
    await this.deps.store.putPrefs(user, prefs);
    return this.settings(identity);
  }

  /** A new notification: email it later, add it to the digest, or nothing, as the user prefers. */
  async notified(user: string, n: Notification): Promise<void> {
    try {
      const prefs = await this.deps.store.prefs(user);
      switch (prefs.modes[EMAIL_CATEGORY[n.kind]]) {
        case 'off':
          return;
        case 'digest':
          await this.deps.store.queueDigest({ user, notificationId: n.id });
          return;
        case 'immediate':
          await this.deps.timers?.schedule(
            `email:${user}:${n.id}`,
            new Date(this.now().getTime() + EMAIL_DELAY_MS),
            { kind: 'email', user, id: n.id },
          );
      }
    } catch (e) {
      console.error('email queueing failed', { error: String(e) });
    }
  }

  /** The delay is over: send if it's still unread and they're still away. */
  async sendNow(user: string, id: string): Promise<void> {
    const n = await this.deps.notifications.get(user, id);
    if (!n || n.read || !(await this.away(user))) return;
    const to = await this.deps.store.address(user);
    if (!to) return;
    const category = EMAIL_CATEGORY[n.kind];
    // The preference may have changed during the delay.
    if ((await this.deps.store.prefs(user)).modes[category] !== 'immediate') return;
    const link = `${this.deps.webUrl}/games/${n.gameId}`;
    const unsubscribe = await this.unsubscribeLinks(user, category);
    await this.deps.mailer.send({
      to,
      subject: `${n.text} · ${n.gameName}`,
      text: [
        n.text,
        `Game: ${n.gameName}`,
        `Open it: ${link}`,
        '',
        footerText(this.deps.webUrl, unsubscribe.page, CATEGORY_LABEL[category]),
      ].join('\n'),
      html: page(
        `<p>${esc(n.text)}</p><p>Game: <a href="${esc(link)}">${esc(n.gameName)}</a></p>`,
        footerHtml(this.deps.webUrl, unsubscribe.page, CATEGORY_LABEL[category]),
      ),
      headers: unsubscribe.headers,
    });
  }

  /**
   * The digest run: one email per user listing their unread notifications that wait for it. Daily
   * users are only sent the evening one; what's read by then, or seen while they're on the site,
   * is dropped.
   */
  async digest(slot: DigestSlot): Promise<{ sent: number }> {
    let sent = 0;
    for (const [user, ids] of await this.deps.store.digestQueue()) {
      try {
        const prefs = await this.deps.store.prefs(user);
        if (prefs.digest === 'daily' && slot === 'morning') continue;
        await this.deps.store.clearDigest(user, ids);
        if (!(await this.away(user))) continue;
        const items = (
          await Promise.all(ids.map((id) => this.deps.notifications.get(user, id)))
        ).filter(
          (n): n is Notification =>
            !!n && !n.read && prefs.modes[EMAIL_CATEGORY[n.kind]] === 'digest',
        );
        const to = await this.deps.store.address(user);
        if (!items.length || !to) continue;
        await this.deps.mailer.send(await this.digestEmail(user, to, items));
        sent++;
      } catch (e) {
        console.error('digest failed', { error: String(e) });
      }
    }
    return { sent };
  }

  /** From a link in an email: no sign-in needed, the signature is the proof. */
  async unsubscribe(req: UnsubscribeRequest): Promise<void> {
    const expected = await this.sign(req.u, req.c);
    const given = Buffer.from(req.t);
    if (given.length !== expected.length || !timingSafeEqual(given, Buffer.from(expected))) {
      throw new ApiError(403, 'bad_link', 'This unsubscribe link is not valid');
    }
    const prefs = await this.deps.store.prefs(req.u);
    const modes = { ...prefs.modes };
    for (const k of Object.keys(modes) as EmailCategory[]) {
      if (req.c === 'all' || req.c === k) modes[k] = 'off';
    }
    await this.deps.store.putPrefs(req.u, { ...prefs, modes });
  }

  private async digestEmail(user: string, to: string, items: Notification[]): Promise<Email> {
    const games = new Map<string, Notification[]>();
    for (const n of [...items].reverse()) games.set(n.gameId, [...(games.get(n.gameId) ?? []), n]);
    const unsubscribe = await this.unsubscribeLinks(user, 'all');
    const text: string[] = [];
    let html = '';
    for (const [gameId, list] of games) {
      const link = `${this.deps.webUrl}/games/${gameId}`;
      const name = list[0]?.gameName ?? '';
      text.push(`${name} (${link})`, ...list.map((n) => `- ${n.text}`), '');
      html += `<h2><a href="${esc(link)}">${esc(name)}</a></h2><ul>${list
        .map((n) => `<li>${esc(n.text)}</li>`)
        .join('')}</ul>`;
    }
    const count = items.length;
    return {
      to,
      subject: `${count} ${count === 1 ? 'thing' : 'things'} waiting for you on Torn Signpost`,
      text: [...text, footerText(this.deps.webUrl, unsubscribe.page, 'all email')].join('\n'),
      html: page(html, footerHtml(this.deps.webUrl, unsubscribe.page, 'all email')),
      headers: unsubscribe.headers,
    };
  }

  /** No connection open, or none used lately. */
  private async away(user: string): Promise<boolean> {
    if ((await this.deps.games.userConnections(user)).length === 0) return true;
    const last = await this.deps.store.lastActive(user);
    return !last || this.now().getTime() - last.getTime() > IDLE_MS;
  }

  private async unsubscribeLinks(user: string, c: EmailCategory | 'all') {
    const query = new URLSearchParams({ u: user, c, t: await this.sign(user, c) }).toString();
    return {
      page: `${this.deps.webUrl}/unsubscribe?${query}`,
      headers: {
        'List-Unsubscribe': `<${this.deps.apiUrl}/email/unsubscribe?${query}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };
  }

  private async sign(user: string, c: string): Promise<string> {
    return createHmac('sha256', await this.deps.secret())
      .update(`unsubscribe:${user}:${c}`)
      .digest('base64url');
  }
}

const CATEGORY_LABEL: Record<EmailCategory, string> = {
  turn: 'turn emails',
  decision: 'decision emails',
  mention: 'mention emails',
  judge: 'judge emails',
  deadline: 'deadline emails',
  game: 'game start, end and oust emails',
};

function footerText(webUrl: string, unsubscribe: string, what: string): string {
  return [
    `You get this because you play on Torn Signpost and were away.`,
    `Choose what we email you: ${webUrl}/account`,
    `Stop ${what}: ${unsubscribe}`,
  ].join('\n');
}

function footerHtml(webUrl: string, unsubscribe: string, what: string): string {
  return `<p style="color:#5f5154;font-size:0.85em">You get this because you play on Torn Signpost and were away. <a href="${esc(`${webUrl}/account`)}">Choose what we email you</a> · <a href="${esc(unsubscribe)}">Stop ${esc(what)}</a></p>`;
}

function page(body: string, footer: string): string {
  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;color:#1d1416">${body}<hr>${footer}</body></html>`;
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

function requireUser(identity: Identity): string {
  if (identity.kind !== 'user') throw new ApiError(401, 'sign_in', 'Sign in first');
  return identity.sub;
}
