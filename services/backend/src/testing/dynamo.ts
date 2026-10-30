/**
 * Integration tests run against DynamoDB Local (`pnpm db:up`, or the CI service container), each
 * suite in its own throwaway table. Without DynamoDB Local they're skipped, except in CI.
 */
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { documentClient } from '../db/client.ts';
import { deleteTable, ensureTable } from '../db/schema-setup.ts';
import { GameStore } from '../db/store.ts';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
const raw = new DynamoDBClient({
  endpoint,
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

export async function dynamoAvailable(): Promise<boolean> {
  try {
    await raw.send(new ListTablesCommand({}), { abortSignal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    if (process.env.CI) throw new Error(`DynamoDB Local is required in CI (${endpoint})`);
    console.warn(`Skipping DynamoDB integration tests: nothing at ${endpoint} (run pnpm db:up)`);
    return false;
  }
}

export async function testStore(): Promise<{
  store: GameStore;
  db: DynamoDBDocumentClient;
  tableName: string;
  cleanup: () => Promise<void>;
}> {
  const tableName = `ts-test-${randomUUID()}`;
  await ensureTable(raw, tableName);
  const db = documentClient({ tableName, endpoint });
  return {
    store: new GameStore(db, tableName),
    db,
    tableName,
    cleanup: () => deleteTable(raw, tableName),
  };
}
