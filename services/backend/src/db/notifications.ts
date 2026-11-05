/**
 * Notifications (NOTIF-01) and the judge registry. Notification IDs start with the time they were
 * sent, so the sort key orders them and a page can start after any ID.
 *
 * | Item | PK | SK |
 * |---|---|---|
 * | Notification | `USER#<sub>` | `NOTIF#<id>` (TTL 30 days) |
 * | Judge | `JUDGES` | `USER#<sub>` (judges seen recently, TTL 30 days; who judge calls go to) |
 */
import {
  type DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Notification } from '@torn-signpost/protocol';

const KEEP = 30 * 24 * 60 * 60;
const epoch = () => Math.floor(Date.now() / 1000);
const userKey = (sub: string) => `USER#${sub}`;
const notifKey = (id: string) => `NOTIF#${id}`;

export class NotificationStore {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async put(user: string, n: Notification): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: { PK: userKey(user), SK: notifKey(n.id), ...n, ttl: epoch() + KEEP },
      }),
    );
  }

  /** Newest first, starting after `before` (an ID) if given. */
  async list(
    user: string,
    opts: { before?: string; limit: number },
  ): Promise<{ items: Notification[]; more: boolean }> {
    const page = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :n)',
        ExpressionAttributeValues: { ':pk': userKey(user), ':n': 'NOTIF#' },
        ScanIndexForward: false,
        Limit: opts.limit + 1,
        ...(opts.before
          ? { ExclusiveStartKey: { PK: userKey(user), SK: notifKey(opts.before) } }
          : {}),
      }),
    );
    const all = page.Items ?? [];
    return { items: all.slice(0, opts.limit).map(toNotification), more: all.length > opts.limit };
  }

  /** How many of the latest `cap` notifications are unread. */
  async unread(user: string, cap: number): Promise<number> {
    const page = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :n)',
        ExpressionAttributeValues: { ':pk': userKey(user), ':n': 'NOTIF#' },
        ProjectionExpression: '#r',
        ExpressionAttributeNames: { '#r': 'read' },
        ScanIndexForward: false,
        Limit: cap,
      }),
    );
    return (page.Items ?? []).filter((i) => !i.read).length;
  }

  /** Mark notifications read; IDs that don't exist (expired, or someone else's) are skipped. */
  async markRead(user: string, ids: string[]): Promise<void> {
    for (const id of ids) {
      try {
        await this.db.send(
          new UpdateCommand({
            TableName: this.table,
            Key: { PK: userKey(user), SK: notifKey(id) },
            UpdateExpression: 'SET #r = :t',
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeNames: { '#r': 'read' },
            ExpressionAttributeValues: { ':t': true },
          }),
        );
      } catch (e) {
        if ((e as { name?: string }).name !== 'ConditionalCheckFailedException') throw e;
      }
    }
  }

  /** The IDs of the latest `cap` unread notifications. */
  async unreadIds(user: string, cap: number): Promise<string[]> {
    const page = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :n)',
        ExpressionAttributeValues: { ':pk': userKey(user), ':n': 'NOTIF#' },
        ProjectionExpression: 'id, #r',
        ExpressionAttributeNames: { '#r': 'read' },
        ScanIndexForward: false,
        Limit: cap,
      }),
    );
    return (page.Items ?? []).filter((i) => !i.read).map((i) => i.id as string);
  }

  /** Remember a judge, so judge calls reach them (refreshed whenever they connect). */
  async putJudge(sub: string): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: { PK: 'JUDGES', SK: userKey(sub), sub, ttl: epoch() + KEEP },
      }),
    );
  }

  async judges(): Promise<string[]> {
    const page = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': 'JUDGES' },
      }),
    );
    return (page.Items ?? []).map((i) => i.sub as string);
  }
}

function toNotification(item: Record<string, unknown>): Notification {
  const { PK: _pk, SK: _sk, ttl: _ttl, ...n } = item;
  return { ...(n as unknown as Notification), read: !!n.read };
}
