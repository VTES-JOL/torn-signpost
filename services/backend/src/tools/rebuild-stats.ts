/**
 * Rebuild every result, stat and history entry from the finished games' event logs (docs/m6-plan.md
 * M6.3, S4): for games finished before stats existed, and after a change to how they're counted.
 *
 *   TABLE_NAME=ts-local-main DYNAMODB_ENDPOINT=http://localhost:8000 pnpm stats:rebuild
 *   TABLE_NAME=ts-beta-main CONTENT_URL=https://content.tornsignpost.org pnpm stats:rebuild
 *
 * Without DYNAMODB_ENDPOINT it uses the AWS credentials in the environment.
 */
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { evolve, newGame } from '@torn-signpost/engine';
import { cdnContent } from '../content/catalog.ts';
import { documentClient } from '../db/client.ts';
import { DeckStore } from '../db/decks.ts';
import { ProfileStore } from '../db/profiles.ts';
import { StatsStore } from '../db/stats.ts';
import { type GameMeta, GameStore } from '../db/store.ts';
import { ResultsService } from '../stats/service.ts';

const tableName = process.env.TABLE_NAME;
if (!tableName) throw new Error('Set TABLE_NAME');
const endpoint = process.env.DYNAMODB_ENDPOINT;
const db = documentClient(endpoint ? { tableName, endpoint } : { tableName });
const games = new GameStore(db, tableName);
const stats = new StatsStore(db, tableName);
const results = new ResultsService({
  store: stats,
  games,
  profiles: new ProfileStore(db, tableName),
  decks: new DeckStore(db, tableName),
  content: cdnContent(process.env.CONTENT_URL ?? 'https://content.tornsignpost.org'),
});

const finished: string[] = [];
let start: Record<string, unknown> | undefined;
do {
  const page = await db.send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: 'SK = :meta AND #status = :finished AND begins_with(PK, :game)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':meta': 'META', ':finished': 'finished', ':game': 'GAME#' },
      ProjectionExpression: 'id',
      ...(start ? { ExclusiveStartKey: start } : {}),
    }),
  );
  for (const i of page.Items ?? []) finished.push(i.id as string);
  start = page.LastEvaluatedKey;
} while (start);

console.log(`Clearing results and stats… (${await stats.clear()} items)`);
let counted = 0;
for (const id of finished) {
  const meta = (await games.getMeta(id)) as GameMeta;
  const base = (await games.snapshot(id)) ?? newGame(id);
  const state = (await games.events(id, base.seq)).reduce(evolve, base);
  if (await results.record(meta, state)) counted++;
}
console.log(`${finished.length} finished games, ${counted} counted.`);
