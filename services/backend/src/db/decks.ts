/**
 * Decks (architecture §5.3, DECK-03/07). Every save of the card list is a new immutable version,
 * so the exact list played in a game stays on record.
 *
 * | Item | PK | SK |
 * |---|---|---|
 * | Deck | `DECK#<id>` | `META` (GSI1 `DECKS#<format>` / updatedAt, public decks only) |
 * | Version | `DECK#<id>` | `V#<n:06d>` |
 * | Ownership | `USER#<sub>` | `DECK#<id>` |
 */
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { DeckCards, DeckDetails, DeckSummary, DeckVersion } from '@torn-signpost/protocol';

export type DeckMeta = Omit<DeckDetails, 'cards'>;

const pad = (n: number) => String(n).padStart(6, '0');
const deckKey = (id: string) => `DECK#${id}`;

export class DeckStore {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async create(meta: DeckMeta, cards: DeckCards): Promise<void> {
    await this.db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.table,
              Item: this.metaItem(meta),
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: this.table,
              Item: this.versionItem(meta.id, 1, cards, meta.updatedAt),
            },
          },
          {
            Put: {
              TableName: this.table,
              Item: { PK: `USER#${meta.owner}`, SK: deckKey(meta.id), deckId: meta.id },
            },
          },
        ],
      }),
    );
  }

  /**
   * Replace the deck's details; with `cards`, also add version `meta.version`. Conditional on the
   * stored version being `expectedVersion`, so concurrent edits can't silently overwrite each other.
   */
  async update(meta: DeckMeta, expectedVersion: number, cards?: DeckCards): Promise<boolean> {
    const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: this.table,
          Item: this.metaItem(meta),
          ConditionExpression: 'version = :v AND #owner = :owner',
          ExpressionAttributeNames: { '#owner': 'owner' },
          ExpressionAttributeValues: { ':v': expectedVersion, ':owner': meta.owner },
        },
      },
    ];
    if (cards) {
      items.push({
        Put: {
          TableName: this.table,
          Item: this.versionItem(meta.id, meta.version, cards, meta.updatedAt),
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      });
    }
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: items }));
      return true;
    } catch (e) {
      if (e instanceof TransactionCanceledException) return false;
      throw e;
    }
  }

  async get(id: string): Promise<DeckMeta | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { PK: deckKey(id), SK: 'META' } }),
    );
    return Item ? toMeta(Item) : undefined;
  }

  async version(id: string, version: number): Promise<DeckVersion | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { PK: deckKey(id), SK: `V#${pad(version)}` } }),
    );
    return Item
      ? { id, version, cards: Item.cards as DeckCards, createdAt: Item.createdAt as string }
      : undefined;
  }

  /** Removes the deck from listings. Versions are kept: games may have been played with them. */
  async delete(id: string, owner: string): Promise<boolean> {
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: this.table,
                Key: { PK: deckKey(id), SK: 'META' },
                ConditionExpression: '#owner = :owner',
                ExpressionAttributeNames: { '#owner': 'owner' },
                ExpressionAttributeValues: { ':owner': owner },
              },
            },
            { Delete: { TableName: this.table, Key: { PK: `USER#${owner}`, SK: deckKey(id) } } },
          ],
        }),
      );
      return true;
    } catch (e) {
      if (e instanceof TransactionCanceledException) return false;
      throw e;
    }
  }

  async listOwned(owner: string): Promise<DeckSummary[]> {
    const links = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `USER#${owner}`, ':sk': 'DECK#' },
      }),
    );
    const keys = (links.Items ?? []).map((l) => ({ PK: l.SK as string, SK: 'META' }));
    const metas: DeckSummary[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      const out = await this.db.send(
        new BatchGetCommand({ RequestItems: { [this.table]: { Keys: keys.slice(i, i + 100) } } }),
      );
      metas.push(...(out.Responses?.[this.table] ?? []).map((m) => summary(toMeta(m))));
    }
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listPublic(format: string, limit = 50): Promise<DeckSummary[]> {
    const out = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `DECKS#${format}` },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (out.Items ?? []).map((m) => summary(toMeta(m)));
  }

  private metaItem(meta: DeckMeta) {
    return {
      PK: deckKey(meta.id),
      SK: 'META',
      ...meta,
      ...(meta.visibility === 'public'
        ? { GSI1PK: `DECKS#${meta.format}`, GSI1SK: meta.updatedAt }
        : {}),
    };
  }

  private versionItem(id: string, version: number, cards: DeckCards, createdAt: string) {
    return { PK: deckKey(id), SK: `V#${pad(version)}`, cards, createdAt };
  }
}

function toMeta(item: Record<string, unknown>): DeckMeta {
  const { PK: _p, SK: _s, GSI1PK: _g, GSI1SK: _gs, ...meta } = item;
  return meta as unknown as DeckMeta;
}

export function summary(meta: DeckMeta): DeckSummary {
  const { notes: _, ...rest } = meta;
  return rest;
}
