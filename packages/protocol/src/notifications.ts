/**
 * In-app notifications (NOTIF-01, TEMPO-01): kept for 30 days, listed newest first, and pushed
 * over the WebSocket to every connection the user has open.
 */
import { z } from 'zod';

export const NOTIFICATION_KINDS = [
  /** Your turn has started. */
  'turn',
  /** A decision waits on you: a block, a card to play or pass, a resolution, combat. */
  'decision',
  /** Someone @mentioned you in a game's chat. */
  'mention',
  /** A judge call was opened (to judges). */
  'judge-call',
  /** A judge ruled on your call. */
  'ruling',
  /** Half your time for a decision has gone (TEMPO-04). */
  'deadline',
  /** You were ousted or disqualified. */
  'ousted',
  /** A game you joined has started. */
  'started',
  /** A judge referred a game to the admins (to admins). */
  'escalation',
  /** A game you played in is over. */
  'ended',
  /** Your withdrawal no longer holds, or it took you out of the game. */
  'withdrawal',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface Notification {
  id: string;
  kind: NotificationKind;
  gameId: string;
  gameName: string;
  /** One line, e.g. "Block Vera Nightfall's bleed?". */
  text: string;
  at: string;
  /** The game's seq when it was sent, to link to the moment. */
  seq: number;
  read: boolean;
}

export interface NotificationsResponse {
  items: Notification[];
  /** Unread among the most recent notifications (at most `UNREAD_CAP`; shown as "50+"). */
  unread: number;
  /** Pass as `before` for the next page. */
  next?: string;
}

/** Unread counts stop at this many. */
export const UNREAD_CAP = 50;

/** Mark these notifications read, or all of them. */
export const MarkReadRequest = z.union([
  z.strictObject({ ids: z.array(z.string().min(1).max(64)).min(1).max(100) }),
  z.strictObject({ all: z.literal(true) }),
]);
export type MarkReadRequest = z.infer<typeof MarkReadRequest>;
