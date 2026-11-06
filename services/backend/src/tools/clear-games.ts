/**
 * Delete every game from a table: their events, snapshots, chat and results, the lobby, the judge
 * and admin queues, notifications, and every player's game history and stats. Accounts, handles,
 * email settings and decks stay. For clearing test games off the beta before real play.
 *
 * Without --yes it only says what it would delete. It refuses while anyone is watching a game.
 *
 *   TABLE_NAME=ts-local-main DYNAMODB_ENDPOINT=http://localhost:8000 pnpm games:clear
 *   TABLE_NAME=ts-beta-main pnpm games:clear --yes
 *
 * Without DYNAMODB_ENDPOINT it uses the AWS credentials in the environment. Warm servers may show
 * cached leaderboards for a few minutes after.
 */
import { BatchWriteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { documentClient } from '../db/client.ts';
import { type Key, plan } from './game-data.ts';

const tableName = process.env.TABLE_NAME;
if (!tableName) throw new Error('Set TABLE_NAME');
const endpoint = process.env.DYNAMODB_ENDPOINT;
const db = documentClient(endpoint ? { tableName, endpoint } : { tableName });
const confirmed = process.argv.includes('--yes');

const items: Key[] = [];
let start: Record<string, unknown> | undefined;
do {
  const page = await db.send(
    new ScanCommand({
      TableName: tableName,
      ProjectionExpression: 'PK, SK, #ttl',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ...(start ? { ExclusiveStartKey: start } : {}),
    }),
  );
  items.push(...((page.Items ?? []) as Key[]));
  start = page.LastEvaluatedKey;
} while (start);

const p = plan(items, Math.floor(Date.now() / 1000));
console.log(`Table ${tableName}: ${items.length} items, ${p.games} games.`);
console.log('To delete:', p.counts, `(${p.keys.length} items)`);
if (p.watched.length > 0) {
  console.error(`Someone is watching ${p.watched.length} game(s): ${p.watched.join(', ')}.`);
  console.error(
    'Ask them to close those pages, or wait up to 3 hours for the connections to expire.',
  );
  process.exit(1);
}
if (!confirmed) {
  console.log('Nothing deleted. Run again with --yes to delete them.');
  process.exit(0);
}

let deleted = 0;
for (let i = 0; i < p.keys.length; i += 25) {
  let requests = p.keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
  for (let attempt = 0; requests.length > 0; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 50, 5000)));
    const res = await db.send(new BatchWriteCommand({ RequestItems: { [tableName]: requests } }));
    const left = (res.UnprocessedItems?.[tableName] ?? []) as typeof requests;
    deleted += requests.length - left.length;
    requests = left;
  }
  if (deleted % 1000 < 25) console.log(`…${deleted} deleted`);
}
console.log(`Deleted ${deleted} items. Stats are empty; nothing to rebuild.`);
