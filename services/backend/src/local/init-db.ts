/** Creates the main table in DynamoDB Local if it doesn't exist yet (`pnpm db:up`). */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ensureTable, waitForDynamo } from '../db/schema-setup.ts';
import { local } from './env.ts';

const client = new DynamoDBClient(local.dynamodb);
try {
  await waitForDynamo(client);
} catch (e) {
  throw new Error(`DynamoDB Local not reachable at ${local.dynamodb.endpoint}: ${e}`);
}
const created = await ensureTable(client, local.tableName);
console.log(
  created ? `Created table ${local.tableName}` : `Table ${local.tableName} already exists`,
);
