/**
 * Email notifications (NOTIF-02): per kind, at once, in a digest, or not at all; only ever sent
 * while the player is away from the site.
 */
import { z } from 'zod';
import type { NotificationKind } from './notifications.ts';

export const EMAIL_CATEGORIES = [
  'turn',
  'decision',
  'mention',
  'judge',
  'deadline',
  'game',
] as const;
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

/** Which email preference each notification kind follows. */
export const EMAIL_CATEGORY: Record<NotificationKind, EmailCategory> = {
  turn: 'turn',
  decision: 'decision',
  mention: 'mention',
  'judge-call': 'judge',
  ruling: 'judge',
  deadline: 'deadline',
  ousted: 'game',
  started: 'game',
  escalation: 'judge',
};

export const EmailMode = z.enum(['immediate', 'digest', 'off']);
export type EmailMode = z.infer<typeof EmailMode>;

export const EmailPrefs = z.strictObject({
  modes: z.strictObject({
    turn: EmailMode,
    decision: EmailMode,
    mention: EmailMode,
    judge: EmailMode,
    deadline: EmailMode,
    game: EmailMode,
  }),
  /** Digests go out at 17:00 UTC, or at 05:00 and 17:00 UTC. */
  digest: z.enum(['daily', 'twice-daily']),
});
export type EmailPrefs = z.infer<typeof EmailPrefs>;

/** Deadlines and judge matters at once; everything else in a daily digest (decision 4). */
export const DEFAULT_EMAIL_PREFS: EmailPrefs = {
  modes: {
    turn: 'digest',
    decision: 'digest',
    mention: 'digest',
    judge: 'immediate',
    deadline: 'immediate',
    game: 'digest',
  },
  digest: 'daily',
};

export interface EmailSettings {
  /** Where email goes: the verified address the user signed in with, if any. */
  address?: string;
  prefs: EmailPrefs;
}

/** From an unsubscribe link: no sign-in, the signature is the proof. */
export const UnsubscribeRequest = z.strictObject({
  u: z.string().min(1).max(128),
  c: z.union([z.enum(EMAIL_CATEGORIES), z.literal('all')]),
  t: z.string().min(16).max(128),
});
export type UnsubscribeRequest = z.infer<typeof UnsubscribeRequest>;
