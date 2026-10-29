/**
 * DynamoDB access for games and live connections (architecture §5.3). Single table; keys:
 *
 * | Item | PK | SK |
 * |---|---|---|
 * | Game meta | `GAME#<id>` | `META` (GSI1 `LOBBY#<status>` / createdAt, public games only) |
 * | Event | `GAME#<id>` | `EV#<seq:010d>` |
 * | Snapshot | `GAME#<id>` | `SNAP#<seq:010d>` (gzip JSON) |
 * | Command dedupe | `GAME#<id>` | `CMD#<commandId>` (TTL 24 h) |
 * | Membership | `USER#<sub>` | `GAME#<id>` |
 * | Connection | `CONN#<connId>` | `META` (TTL 3 h) |
 * | Subscription | `SUB#<gameId>` | `CONN#<connId>` (TTL 3 h) |
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { GameEvent, GameState } from '@torn-signpost/engine';
import type { CreateGameRequest, DeckList, LobbyStatus } from '@torn-signpost/protocol';
import type { Identity } from '../auth.ts';

export interface Player {
  user: string;
  name: string;
  /** Kept until the game starts; the deck then lives in the GameStarted event. */
  deck?: DeckList;
}

export interface GameMeta extends CreateGameRequest {
  id: string;
  status: LobbyStatus;
  players: Player[];
  createdBy: string;
  createdAt: string;
  seq: number;
  engineVersion: string;
}

export interface StoredCommand {
  user: string;
  firstSeq: number;
  lastSeq: number;
}

export interface Subscriber {
  connectionId: string;
  identity: Identity;
}

export type AppendResult = 'ok' | 'conflict' | 'duplicate';

const DAY = 24 * 60 * 60;
const CONNECTION_TTL = 3 * 60 * 60;
const pad = (n: number) => String(n).padStart(10, '0');
const gameKey = (id: string) => `GAME#${id}`;
const epoch = () => Math.floor(Date.now() / 1000);

export class GameStore {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async createGame(meta: GameMeta): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: { PK: gameKey(meta.id), SK: 'META', ...meta, ...this.lobbyIndex(meta) },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  }

  async getMeta(id: string): Promise<GameMeta | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { PK: gameKey(id), SK: 'META' } }),
    );
    return Item ? toMeta(Item) : undefined;
  }

  /** Adds a player if the game is open, not full and they haven't joined; false otherwise. */
  async addPlayer(id: string, player: Player): Promise<boolean> {
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: { PK: gameKey(id), SK: 'META' },
                UpdateExpression:
                  'SET players = list_append(players, :p), playerCount = playerCount + :one ADD userIds :u',
                ConditionExpression:
                  '#status = :open AND playerCount < maxSeats AND NOT contains(userIds, :user)',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':p': [player],
                  ':one': 1,
                  ':u': new Set([player.user]),
                  ':user': player.user,
                  ':open': 'open',
                },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { PK: `USER#${player.user}`, SK: gameKey(id), gameId: id },
              },
            },
          ],
        }),
      );
      return true;
    } catch (e) {
      if (e instanceof TransactionCanceledException) return false;
      throw e;
    }
  }

  async listGames(status: LobbyStatus, limit = 50): Promise<GameMeta[]> {
    const items = await this.query(
      {
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `LOBBY#${status}` },
        ScanIndexForward: false,
      },
      limit,
    );
    return items.map(toMeta);
  }

  async listUserGames(user: string, limit = 100): Promise<GameMeta[]> {
    const memberships = await this.query(
      {
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `USER#${user}`, ':sk': 'GAME#' },
      },
      limit,
    );
    const metas: GameMeta[] = [];
    for (let i = 0; i < memberships.length; i += 100) {
      const keys = memberships.slice(i, i + 100).map((m) => ({ PK: m.SK, SK: 'META' }));
      const out = await this.db.send(
        new BatchGetCommand({ RequestItems: { [this.table]: { Keys: keys } } }),
      );
      metas.push(...(out.Responses?.[this.table] ?? []).map(toMeta));
    }
    return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Events with seq > `after`, oldest first. */
  async events(id: string, after: number, limit?: number): Promise<GameEvent[]> {
    const items = await this.query(
      {
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': gameKey(id),
          ':from': `EV#${pad(after + 1)}`,
          ':to': `EV#${pad(9_999_999_999)}`,
        },
      },
      limit,
    );
    return items.map((i) => JSON.parse(i.event as string) as GameEvent);
  }

  /** The latest snapshot at or before `atOrBefore`. */
  async snapshot(id: string, atOrBefore = 9_999_999_999): Promise<GameState | undefined> {
    const [item] = await this.query(
      {
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': gameKey(id),
          ':from': `SNAP#${pad(0)}`,
          ':to': `SNAP#${pad(atOrBefore)}`,
        },
        ScanIndexForward: false,
      },
      1,
    );
    if (!item) return undefined;
    return JSON.parse(gunzipSync(item.state as Uint8Array).toString('utf8')) as GameState;
  }

  async getCommand(id: string, commandId: string): Promise<StoredCommand | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: gameKey(id), SK: `CMD#${commandId}` },
        ConsistentRead: true,
      }),
    );
    return Item ? { user: Item.user, firstSeq: Item.firstSeq, lastSeq: Item.lastSeq } : undefined;
  }

  /**
   * Append a command's events in one transaction, conditional on the game still being at
   * `expectedSeq` (NFR-04) and the command ID not having been used (idempotency, §5.2).
   */
  async append(args: {
    id: string;
    expectedSeq: number;
    events: GameEvent[];
    commandId: string;
    user: string;
    snapshot?: GameState;
    meta?: Partial<Pick<GameMeta, 'status' | 'players'>>;
    /** Public games move between lobby lists as their status changes. */
    listed?: boolean;
  }): Promise<AppendResult> {
    const { id, expectedSeq, events, commandId, user } = args;
    const lastSeq = events.at(-1)?.seq ?? expectedSeq;
    const sets = ['seq = :seq'];
    const values: Record<string, unknown> = { ':seq': lastSeq, ':expected': expectedSeq };
    const names: Record<string, string> = {};
    if (args.meta?.status) {
      sets.push('#status = :status');
      names['#status'] = 'status';
      values[':status'] = args.meta.status;
      if (args.listed) {
        sets.push('GSI1PK = :lobby');
        values[':lobby'] = `LOBBY#${args.meta.status}`;
      }
    }
    if (args.meta?.players) {
      sets.push('players = :players');
      values[':players'] = args.meta.players;
    }
    const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Update: {
          TableName: this.table,
          Key: { PK: gameKey(id), SK: 'META' },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'seq = :expected',
          ExpressionAttributeValues: values,
          ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        },
      },
      {
        Put: {
          TableName: this.table,
          Item: {
            PK: gameKey(id),
            SK: `CMD#${commandId}`,
            user,
            firstSeq: expectedSeq + 1,
            lastSeq,
            ttl: epoch() + DAY,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      ...events.map((ev) => ({
        Put: {
          TableName: this.table,
          Item: { PK: gameKey(id), SK: `EV#${pad(ev.seq)}`, event: JSON.stringify(ev), commandId },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      })),
    ];
    if (args.snapshot) {
      items.push({
        Put: {
          TableName: this.table,
          Item: {
            PK: gameKey(id),
            SK: `SNAP#${pad(args.snapshot.seq)}`,
            state: gzipSync(JSON.stringify(args.snapshot)),
          },
        },
      });
    }
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: items }));
      return 'ok';
    } catch (e) {
      if (!(e instanceof TransactionCanceledException)) throw e;
      const reasons = e.CancellationReasons ?? [];
      if (reasons[1]?.Code === 'ConditionalCheckFailed') return 'duplicate';
      return 'conflict';
    }
  }

  // Live connections (architecture §5.4)

  async putConnection(connectionId: string, identity: Identity): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          PK: `CONN#${connectionId}`,
          SK: 'META',
          identity,
          games: [],
          ttl: epoch() + CONNECTION_TTL,
        },
      }),
    );
  }

  async getConnection(
    connectionId: string,
  ): Promise<{ identity: Identity; games: string[] } | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { PK: `CONN#${connectionId}`, SK: 'META' } }),
    );
    return Item
      ? { identity: Item.identity as Identity, games: (Item.games as string[]) ?? [] }
      : undefined;
  }

  async subscribe(connectionId: string, gameId: string, identity: Identity): Promise<void> {
    await this.db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.table,
              Item: {
                PK: `SUB#${gameId}`,
                SK: `CONN#${connectionId}`,
                connectionId,
                identity,
                ttl: epoch() + CONNECTION_TTL,
              },
            },
          },
          {
            Update: {
              TableName: this.table,
              Key: { PK: `CONN#${connectionId}`, SK: 'META' },
              UpdateExpression: 'SET games = list_append(games, :g)',
              ConditionExpression: 'attribute_exists(PK)',
              ExpressionAttributeValues: { ':g': [gameId] },
            },
          },
        ],
      }),
    );
  }

  async unsubscribe(connectionId: string, gameId: string): Promise<void> {
    await this.db.send(
      new DeleteCommand({
        TableName: this.table,
        Key: { PK: `SUB#${gameId}`, SK: `CONN#${connectionId}` },
      }),
    );
  }

  async deleteConnection(connectionId: string): Promise<void> {
    const conn = await this.getConnection(connectionId);
    for (const gameId of new Set(conn?.games ?? [])) await this.unsubscribe(connectionId, gameId);
    await this.db.send(
      new DeleteCommand({ TableName: this.table, Key: { PK: `CONN#${connectionId}`, SK: 'META' } }),
    );
  }

  async subscribers(gameId: string): Promise<Subscriber[]> {
    const items = await this.query({
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `SUB#${gameId}` },
    });
    return items.map((i) => ({
      connectionId: i.connectionId as string,
      identity: i.identity as Identity,
    }));
  }

  private lobbyIndex(meta: Pick<GameMeta, 'visibility' | 'status' | 'createdAt' | 'players'>) {
    return {
      playerCount: meta.players.length,
      userIds: meta.players.length ? new Set(meta.players.map((p) => p.user)) : undefined,
      ...(meta.visibility === 'public'
        ? { GSI1PK: `LOBBY#${meta.status}`, GSI1SK: meta.createdAt }
        : {}),
    };
  }

  private async query(
    input: Omit<QueryCommandInput, 'TableName' | 'Limit' | 'ExclusiveStartKey'>,
    limit = Number.POSITIVE_INFINITY,
  ): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new QueryCommand({
          ...input,
          TableName: this.table,
          ...(Number.isFinite(limit) ? { Limit: limit - out.length } : {}),
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      out.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start && out.length < limit);
    return out;
  }
}

function toMeta(item: Record<string, unknown>): GameMeta {
  const {
    PK: _pk,
    SK: _sk,
    GSI1PK: _g,
    GSI1SK: _gs,
    playerCount: _pc,
    userIds: _u,
    ...meta
  } = item;
  return meta as unknown as GameMeta;
}
