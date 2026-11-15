/**
 * Links to Archon, the VEKN's tournament manager (docs/m7-plan.md M7.1): a player's linked Archon
 * account, and the sign-ins under way. An Archon account links to one Torn Signpost account at a
 * time, held by a claim item.
 *
 * | Item | PK | SK |
 * |---|---|---|
 * | Linked account | `USER#<sub>` | `ARCHON` (their Archon uid and VEKN number) |
 * | Claim | `ARCHONUSER#<archon uid>` | `CLAIM` (who it's linked to) |
 * | Sign-in under way | `OAUTH#<state>` | `OAUTH` (the PKCE verifier; TTL 15 minutes) |
 */
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

export interface StoredArchonLink {
  archonUid: string;
  veknId: string | null;
  linkedAt: string;
}

export interface PendingSignIn {
  sub: string;
  verifier: string;
  purpose: 'profile';
  /** Epoch seconds; expired ones are refused before DynamoDB gets round to removing them. */
  expires: number;
}

const linkKey = (sub: string) => ({ PK: `USER#${sub}`, SK: 'ARCHON' });
const claimKey = (archonUid: string) => ({ PK: `ARCHONUSER#${archonUid}`, SK: 'CLAIM' });
const pendingKey = (state: string) => ({ PK: `OAUTH#${state}`, SK: 'OAUTH' });

export class ArchonStore {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async putPending(state: string, p: PendingSignIn): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: { ...pendingKey(state), ...p, ttl: p.expires },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  }

  /** The sign-in for `state`, removed as it's read: a code can complete it once. */
  async takePending(state: string): Promise<PendingSignIn | undefined> {
    const { Attributes } = await this.db.send(
      new DeleteCommand({ TableName: this.table, Key: pendingKey(state), ReturnValues: 'ALL_OLD' }),
    );
    if (!Attributes) return undefined;
    return {
      sub: Attributes.sub as string,
      verifier: Attributes.verifier as string,
      purpose: Attributes.purpose as 'profile',
      expires: Attributes.expires as number,
    };
  }

  async getLink(sub: string): Promise<StoredArchonLink | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.table, Key: linkKey(sub) }),
    );
    return Item
      ? {
          archonUid: Item.archonUid as string,
          veknId: (Item.veknId as string | null) ?? null,
          linkedAt: Item.linkedAt as string,
        }
      : undefined;
  }

  /**
   * Link `sub` to an Archon account, releasing the account they had linked before, if another.
   * `taken` when the Archon account is linked to someone else.
   */
  async putLink(
    sub: string,
    link: StoredArchonLink,
    previous: string | undefined,
  ): Promise<'ok' | 'taken'> {
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: { ...claimKey(link.archonUid), owner: sub },
                ConditionExpression: 'attribute_not_exists(PK) OR #owner = :sub',
                ExpressionAttributeNames: { '#owner': 'owner' },
                ExpressionAttributeValues: { ':sub': sub },
              },
            },
            { Put: { TableName: this.table, Item: { ...linkKey(sub), ...link } } },
            ...(previous && previous !== link.archonUid
              ? [
                  {
                    Delete: {
                      TableName: this.table,
                      Key: claimKey(previous),
                      ConditionExpression: '#owner = :sub',
                      ExpressionAttributeNames: { '#owner': 'owner' },
                      ExpressionAttributeValues: { ':sub': sub },
                    },
                  },
                ]
              : []),
          ],
        }),
      );
      return 'ok';
    } catch (e) {
      if (e instanceof TransactionCanceledException) return 'taken';
      throw e;
    }
  }

  async deleteLink(sub: string, archonUid: string): Promise<void> {
    await this.db.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: this.table, Key: linkKey(sub) } },
          {
            Delete: {
              TableName: this.table,
              Key: claimKey(archonUid),
              ConditionExpression: 'attribute_not_exists(PK) OR #owner = :sub',
              ExpressionAttributeNames: { '#owner': 'owner' },
              ExpressionAttributeValues: { ':sub': sub },
            },
          },
        ],
      }),
    );
  }
}
