/**
 * Profiles (architecture §5.3, AUTH-05). A name is claimed by a `HANDLE#` item so two users can't
 * hold it at once, whatever its case. Claims are never released, so a name can't be reused to
 * impersonate its former holder.
 *
 * | Item | PK | SK |
 * |---|---|---|
 * | Profile | `USER#<sub>` | `PROFILE` |
 * | Name claim | `HANDLE#<lowercase name>` | `HANDLE` |
 */
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  type DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';

export interface StoredProfile {
  name: string;
  updatedAt: string;
}

const handleKey = (name: string) => ({ PK: `HANDLE#${name.toLowerCase()}`, SK: 'HANDLE' });
const profileKey = (sub: string) => ({ PK: `USER#${sub}`, SK: 'PROFILE' });

export class ProfileStore {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async get(sub: string): Promise<StoredProfile | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.table, Key: profileKey(sub) }),
    );
    return Item ? { name: Item.name as string, updatedAt: Item.updatedAt as string } : undefined;
  }

  /** The user who claimed `name` (now or in the past). */
  async ownerOf(name: string): Promise<string | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.table, Key: handleKey(name) }),
    );
    return Item?.owner as string | undefined;
  }

  /**
   * Claim `name`; the user keeps their claim on `previous`. Conditional on the profile still
   * holding `previous`, so concurrent renames can't both win.
   */
  async rename(
    sub: string,
    name: string,
    previous: string | undefined,
    at: string,
  ): Promise<'ok' | 'taken' | 'stale'> {
    const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: this.table,
          Item: { ...handleKey(name), owner: sub, name },
          ConditionExpression: 'attribute_not_exists(PK) OR #owner = :sub',
          ExpressionAttributeNames: { '#owner': 'owner' },
          ExpressionAttributeValues: { ':sub': sub },
        },
      },
      {
        Put: {
          TableName: this.table,
          Item: { ...profileKey(sub), name, updatedAt: at },
          ...(previous
            ? {
                ConditionExpression: '#name = :previous',
                ExpressionAttributeNames: { '#name': 'name' },
                ExpressionAttributeValues: { ':previous': previous },
              }
            : { ConditionExpression: 'attribute_not_exists(PK)' }),
        },
      },
    ];
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: items }));
      return 'ok';
    } catch (e) {
      if (!(e instanceof TransactionCanceledException)) throw e;
      return e.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed' ? 'taken' : 'stale';
    }
  }
}
