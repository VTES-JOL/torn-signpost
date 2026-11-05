/**
 * Email notifications (NOTIF-02): where to send, what to send, and what waits for the digest.
 *
 * | Item | PK | SK |
 * |---|---|---|
 * | Address | `USER#<sub>` | `EMAIL` (the verified sign-in address, refreshed as they sign in) |
 * | Preferences | `USER#<sub>` | `EMAILPREFS` |
 * | Digest queue | `DIGESTQ` | `<sub>#<notificationId>` (TTL 3 days) |
 * | Last activity | `USER#<sub>` | `ACTIVE` (when they last used the site; TTL 30 days) |
 */
import {
  BatchWriteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { DEFAULT_EMAIL_PREFS, EmailPrefs } from '@torn-signpost/protocol';

const DIGEST_TTL = 3 * 24 * 60 * 60;
const epoch = () => Math.floor(Date.now() / 1000);
const userKey = (sub: string) => `USER#${sub}`;

export interface DigestItem {
  user: string;
  notificationId: string;
}

export class EmailStore {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async address(sub: string): Promise<string | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { PK: userKey(sub), SK: 'EMAIL' } }),
    );
    return Item?.address as string | undefined;
  }

  async putAddress(sub: string, address: string): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: { PK: userKey(sub), SK: 'EMAIL', address },
      }),
    );
  }

  /** Saved preferences, or the defaults; anything unreadable falls back to the defaults. */
  async prefs(sub: string): Promise<EmailPrefs> {
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { PK: userKey(sub), SK: 'EMAILPREFS' } }),
    );
    const parsed = EmailPrefs.safeParse(Item?.prefs);
    return parsed.success ? parsed.data : DEFAULT_EMAIL_PREFS;
  }

  async putPrefs(sub: string, prefs: EmailPrefs): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: { PK: userKey(sub), SK: 'EMAILPREFS', prefs },
      }),
    );
  }

  async touch(sub: string, at: Date): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          PK: userKey(sub),
          SK: 'ACTIVE',
          at: at.toISOString(),
          ttl: Math.floor(at.getTime() / 1000) + 30 * 24 * 60 * 60,
        },
      }),
    );
  }

  async lastActive(sub: string): Promise<Date | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { PK: userKey(sub), SK: 'ACTIVE' } }),
    );
    return typeof Item?.at === 'string' ? new Date(Item.at) : undefined;
  }

  async queueDigest(item: DigestItem): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          PK: 'DIGESTQ',
          SK: `${item.user}#${item.notificationId}`,
          ...item,
          ttl: epoch() + DIGEST_TTL,
        },
      }),
    );
  }

  /** Everything waiting for a digest, grouped by user. */
  async digestQueue(): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': 'DIGESTQ' },
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      for (const i of page.Items ?? []) {
        const user = i.user as string;
        out.set(user, [...(out.get(user) ?? []), i.notificationId as string]);
      }
      start = page.LastEvaluatedKey;
    } while (start);
    return out;
  }

  async clearDigest(user: string, ids: readonly string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 25) {
      await this.db.send(
        new BatchWriteCommand({
          RequestItems: {
            [this.table]: ids.slice(i, i + 25).map((id) => ({
              DeleteRequest: { Key: { PK: 'DIGESTQ', SK: `${user}#${id}` } },
            })),
          },
        }),
      );
    }
  }
}
