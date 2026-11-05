/**
 * Results and stats (STATS-01..03, docs/m6-plan.md M6.3).
 *
 * | Item | PK | SK |
 * |---|---|---|
 * | Result | `GAME#<id>` | `RESULT` (counted games only) |
 * | Stats | `USER#<sub>` | `STATS#<season>` (GSI1 `STATS#<season>` / sub, for leaderboards) and `STATS#all` |
 * | History | `USER#<sub>` | `GAME#<id>` (the membership item, gaining `result`) |
 *
 * Counters are flat attributes (`games`, `f_v5_games`, …) so `ADD` works on items that don't
 * exist yet.
 */
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  GameResultRecord,
  HistoryEntry,
  PlayerStats,
  StatLine,
} from '@torn-signpost/protocol';

const FIELDS = ['games', 'replaced', 'gameWins', 'vp', 'wins'] as const;
const FORMATS = ['standard', 'v5', 'duel'] as const;
const userKey = (sub: string) => `USER#${sub}`;

const empty = (): StatLine => ({ games: 0, replaced: 0, gameWins: 0, vp: 0, wins: 0 });

function toStats(item: Record<string, unknown> | undefined): PlayerStats {
  const line = (prefix: string): StatLine => {
    const out = empty();
    for (const f of FIELDS) out[f] = Number(item?.[`${prefix}${f}`] ?? 0);
    return out;
  };
  const byFormat: PlayerStats['byFormat'] = {};
  for (const f of FORMATS) {
    const l = line(`f_${f}_`);
    if (l.games) byFormat[f] = l;
  }
  return { ...line(''), byFormat };
}

export class StatsStore {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  /**
   * Record a counted game's result, everyone's stats and history, in one transaction. False if it
   * was already recorded: a retry never counts a game twice.
   */
  async record(
    result: GameResultRecord,
    deltas: ReadonlyMap<string, StatLine>,
    history: ReadonlyMap<string, HistoryEntry>,
    /** Each player's display name now, and the key their page is reached by. */
    names: ReadonlyMap<string, { name: string; key: string }>,
  ): Promise<boolean> {
    const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: this.table,
          Item: { PK: `GAME#${result.gameId}`, SK: 'RESULT', ...result },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ];
    for (const [user, d] of deltas) {
      const adds: string[] = [];
      const values: Record<string, unknown> = {};
      for (const f of FIELDS) {
        adds.push(`${f} :${f}`, `f_${result.format}_${f} :${f}`);
        values[`:${f}`] = d[f];
      }
      for (const sk of [`STATS#${result.season}`, 'STATS#all']) {
        const season = sk !== 'STATS#all';
        items.push({
          Update: {
            TableName: this.table,
            Key: { PK: userKey(user), SK: sk },
            UpdateExpression: `SET ${season ? 'GSI1PK = :lb, GSI1SK = :sub, ' : ''}#user = :sub, #name = :name, #key = :key ADD ${adds.join(', ')}`,
            ExpressionAttributeNames: { '#user': 'user', '#name': 'name', '#key': 'key' },
            ExpressionAttributeValues: {
              ...values,
              ':sub': user,
              ':name': names.get(user)?.name ?? user,
              ':key': names.get(user)?.key ?? user,
              ...(season ? { ':lb': `STATS#${result.season}` } : {}),
            },
          },
        });
      }
    }
    for (const [user, entry] of history) {
      items.push({
        Update: {
          TableName: this.table,
          Key: { PK: userKey(user), SK: `GAME#${result.gameId}` },
          UpdateExpression: 'SET #result = :r, gameId = :g',
          ExpressionAttributeNames: { '#result': 'result' },
          ExpressionAttributeValues: { ':r': entry, ':g': result.gameId },
        },
      });
    }
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: items }));
      return true;
    } catch (e) {
      if (
        e instanceof TransactionCanceledException &&
        e.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
      ) {
        return false;
      }
      throw e;
    }
  }

  async result(gameId: string): Promise<GameResultRecord | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { PK: `GAME#${gameId}`, SK: 'RESULT' } }),
    );
    if (!Item) return undefined;
    const { PK: _p, SK: _s, ...r } = Item;
    return r as unknown as GameResultRecord;
  }

  async stats(sub: string, season: string | 'all'): Promise<PlayerStats> {
    const { Item } = await this.db.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: userKey(sub), SK: season === 'all' ? 'STATS#all' : `STATS#${season}` },
      }),
    );
    return toStats(Item);
  }

  /** The name a player's stats were last recorded under, for players without a chosen name. */
  async name(sub: string): Promise<string | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: userKey(sub), SK: 'STATS#all' },
        ProjectionExpression: '#name',
        ExpressionAttributeNames: { '#name': 'name' },
      }),
    );
    return Item?.name as string | undefined;
  }

  /** Everyone's stats for a season (GSI1), for the leaderboards. */
  async season(
    season: string,
  ): Promise<{ user: string; name: string; key: string; stats: PlayerStats }[]> {
    const out: { user: string; name: string; key: string; stats: PlayerStats }[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: { ':pk': `STATS#${season}` },
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      for (const i of page.Items ?? []) {
        out.push({
          user: i.user as string,
          name: (i.name as string) ?? (i.user as string),
          key: (i.key as string) ?? (i.user as string),
          stats: toStats(i),
        });
      }
      start = page.LastEvaluatedKey;
    } while (start);
    return out;
  }

  /** A player's counted games, newest first. */
  async history(sub: string): Promise<HistoryEntry[]> {
    const out: HistoryEntry[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :g)',
          FilterExpression: 'attribute_exists(#result)',
          ExpressionAttributeNames: { '#result': 'result' },
          ExpressionAttributeValues: { ':pk': userKey(sub), ':g': 'GAME#' },
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      for (const i of page.Items ?? []) out.push(i.result as HistoryEntry);
      start = page.LastEvaluatedKey;
    } while (start);
    return out.sort(
      (a, b) => b.endedAt.localeCompare(a.endedAt) || a.gameId.localeCompare(b.gameId),
    );
  }

  /** A player brought in by a replacement belongs to the game too (their games list). */
  async putMembership(sub: string, gameId: string): Promise<void> {
    await this.db.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: userKey(sub), SK: `GAME#${gameId}` },
        UpdateExpression: 'SET gameId = :g',
        ExpressionAttributeValues: { ':g': gameId },
      }),
    );
  }

  /** For the rebuild: forget every result, stat and history entry. */
  async clear(): Promise<number> {
    let removed = 0;
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression:
            'SK = :result OR begins_with(SK, :stats) OR (begins_with(SK, :game) AND attribute_exists(#result))',
          ExpressionAttributeNames: { '#result': 'result' },
          ExpressionAttributeValues: { ':result': 'RESULT', ':stats': 'STATS#', ':game': 'GAME#' },
          ProjectionExpression: 'PK, SK',
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      const keys = (page.Items ?? []) as { PK: string; SK: string }[];
      for (const k of keys.filter((x) => x.SK.startsWith('GAME#'))) {
        await this.db.send(
          new UpdateCommand({
            TableName: this.table,
            Key: k,
            UpdateExpression: 'REMOVE #result',
            ExpressionAttributeNames: { '#result': 'result' },
          }),
        );
      }
      const deletes = keys.filter((x) => !x.SK.startsWith('GAME#'));
      for (let i = 0; i < deletes.length; i += 25) {
        await this.db.send(
          new BatchWriteCommand({
            RequestItems: {
              [this.table]: deletes.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })),
            },
          }),
        );
      }
      removed += keys.length;
      start = page.LastEvaluatedKey;
    } while (start);
    return removed;
  }
}
