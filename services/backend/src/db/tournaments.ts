/**
 * Tournaments linked to Archon (docs/m7-plan.md M7.2): the link, the organiser's grant (sealed:
 * archon/sealer.ts), and our copy of Archon's state. Archon is the source of truth; the copy is
 * only for our pages, refreshed by polling.
 *
 * | Item | PK | SK |
 * |---|---|---|
 * | Link | `TOURN#<archon uid>` | `META` (the summary, who linked it, how the last read went; GSI1 `TOURNS` / start or link time) |
 * | Grant | `TOURN#<archon uid>` | `GRANT` (sealed refresh and access tokens; a lease while one process refreshes) |
 * | State | `TOURN#<archon uid>` | `STATE` (Archon's state as we keep it, JSON) |
 */
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Member, Tournament } from '@torn-signpost/archon';
import type { TournamentState } from '@torn-signpost/protocol';

export interface TournamentMeta {
  id: string;
  name: string;
  state: TournamentState;
  format: string;
  online: boolean;
  start: string | null;
  finish: string | null;
  timezone: string | null;
  place: string | null;
  players: number;
  archonUrl: string;
  /** The Torn Signpost user who linked it (its organiser here). */
  organiser: string;
  /** The Archon member who granted it (from the grant's token), if Archon said. */
  organiserArchonUid?: string | null;
  linkedAt: string;
  /** When we last read it from Archon successfully. */
  updatedAt: string;
  /** When we last tried. */
  polledAt: string;
  grant: 'ok' | 'lost';
  lastError: string | null;
}

/** What a read from Archon sets on the link. */
export type TournamentSummaryFields = Omit<
  TournamentMeta,
  'organiser' | 'linkedAt' | 'updatedAt' | 'polledAt' | 'grant' | 'lastError'
>;

export interface StoredGrant {
  /** Sealed. */
  refresh: string;
  /** Sealed. */
  access: string;
  /** Epoch seconds. */
  accessExpires: number;
  /** The Archon member who granted it. */
  archonSub: string | null;
}

/** Archon's state as we keep it: the tournament (fields we show) and the members it names. */
export interface CachedTournament {
  tournament: Tournament;
  members: Member[];
}

const pk = (id: string) => `TOURN#${id}`;
const LIST = 'TOURNS';

export class TournamentStore {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  /** Link a tournament (or link it again, with a new grant). */
  async putLink(meta: TournamentMeta, grant: StoredGrant, state: CachedTournament): Promise<void> {
    await this.db.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: this.table, Item: this.metaItem(meta) } },
          { Put: { TableName: this.table, Item: { PK: pk(meta.id), SK: 'GRANT', ...grant } } },
          { Put: { TableName: this.table, Item: this.stateItem(meta.id, state) } },
        ],
      }),
    );
  }

  async getMeta(id: string): Promise<TournamentMeta | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { PK: pk(id), SK: 'META' } }),
    );
    return Item ? toMeta(Item) : undefined;
  }

  async getState(id: string): Promise<CachedTournament | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { PK: pk(id), SK: 'STATE' } }),
    );
    return Item ? (JSON.parse(Item.body as string) as CachedTournament) : undefined;
  }

  async getGrant(id: string): Promise<(StoredGrant & { lease: number | null }) | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: pk(id), SK: 'GRANT' },
        ConsistentRead: true,
      }),
    );
    if (!Item) return undefined;
    return {
      refresh: Item.refresh as string,
      access: Item.access as string,
      accessExpires: Item.accessExpires as number,
      archonSub: (Item.archonSub as string | null) ?? null,
      lease: (Item.lease as number | undefined) ?? null,
    };
  }

  /** Every linked tournament, latest first. */
  async list(): Promise<TournamentMeta[]> {
    const metas: TournamentMeta[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: { ':pk': LIST },
          ScanIndexForward: false,
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      metas.push(...(out.Items ?? []).map(toMeta));
      start = out.LastEvaluatedKey;
    } while (start);
    return metas;
  }

  /**
   * A fresh read from Archon: the new state and the summary from it; the grant worked. Leaves who
   * linked it alone. False if it was unlinked meanwhile.
   */
  async putState(
    summary: TournamentSummaryFields,
    at: string,
    state: CachedTournament,
  ): Promise<boolean> {
    const fields: Record<string, unknown> = {
      ...summary,
      updatedAt: at,
      polledAt: at,
      grant: 'ok',
      lastError: null,
      // Listed by start; one without a start date keeps its place (by when it was linked).
      ...(summary.start ? { GSI1SK: `${summary.start}#${summary.id}` } : {}),
    };
    const names = Object.fromEntries(Object.keys(fields).map((k, i) => [`#f${i}`, k]));
    const values = Object.fromEntries(Object.values(fields).map((v, i) => [`:v${i}`, v]));
    const sets = Object.keys(fields).map((_, i) => `#f${i} = :v${i}`);
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: { PK: pk(summary.id), SK: 'META' },
                UpdateExpression: `SET ${sets.join(', ')}`,
                ConditionExpression: 'attribute_exists(PK)',
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
              },
            },
            { Put: { TableName: this.table, Item: this.stateItem(summary.id, state) } },
          ],
        }),
      );
      return true;
    } catch (e) {
      if (e instanceof TransactionCanceledException) return false;
      throw e;
    }
  }

  /** A read that failed: keep the copy we have, say why. */
  async markFailed(id: string, at: string, error: string, lost = false): Promise<void> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: pk(id), SK: 'META' },
          UpdateExpression: `SET polledAt = :at, lastError = :error${lost ? ', #grant = :lost' : ''}`,
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: {
            ':at': at,
            ':error': error.slice(0, 300),
            ...(lost ? { ':lost': 'lost' } : {}),
          },
          ...(lost ? { ExpressionAttributeNames: { '#grant': 'grant' } } : {}),
        }),
      );
    } catch (e) {
      if (!(e instanceof ConditionalCheckFailedException)) throw e;
    }
  }

  /**
   * Take the right to refresh the grant until `until` (epoch ms): Archon rotates refresh tokens,
   * so two processes refreshing at once would leave one holding a spent token. False if another
   * holds it.
   */
  async takeLease(id: string, now: number, until: number): Promise<boolean> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: pk(id), SK: 'GRANT' },
          UpdateExpression: 'SET lease = :until',
          ConditionExpression:
            'attribute_exists(PK) AND (attribute_not_exists(lease) OR lease < :now)',
          ExpressionAttributeValues: { ':until': until, ':now': now },
        }),
      );
      return true;
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) return false;
      throw e;
    }
  }

  /** New tokens from a refresh; releases the lease. */
  async putTokens(id: string, tokens: Omit<StoredGrant, 'archonSub'>): Promise<void> {
    await this.db.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: pk(id), SK: 'GRANT' },
        UpdateExpression: 'SET refresh = :r, access = :a, accessExpires = :e REMOVE lease',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: {
          ':r': tokens.refresh,
          ':a': tokens.access,
          ':e': tokens.accessExpires,
        },
      }),
    );
  }

  async releaseLease(id: string): Promise<void> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: pk(id), SK: 'GRANT' },
          UpdateExpression: 'REMOVE lease',
          ConditionExpression: 'attribute_exists(PK)',
        }),
      );
    } catch (e) {
      if (!(e instanceof ConditionalCheckFailedException)) throw e;
    }
  }

  async deleteLink(id: string): Promise<void> {
    await this.db.send(
      new TransactWriteCommand({
        TransactItems: ['META', 'GRANT', 'STATE'].map((SK) => ({
          Delete: { TableName: this.table, Key: { PK: pk(id), SK } },
        })),
      }),
    );
  }

  private metaItem(meta: TournamentMeta) {
    return {
      PK: pk(meta.id),
      SK: 'META',
      ...meta,
      GSI1PK: LIST,
      GSI1SK: `${meta.start ?? meta.linkedAt}#${meta.id}`,
    };
  }

  private stateItem(id: string, state: CachedTournament) {
    return { PK: pk(id), SK: 'STATE', body: JSON.stringify(state) };
  }
}

function toMeta(item: Record<string, unknown>): TournamentMeta {
  const { PK: _p, SK: _s, GSI1PK: _g, GSI1SK: _gs, ...meta } = item;
  return meta as unknown as TournamentMeta;
}
