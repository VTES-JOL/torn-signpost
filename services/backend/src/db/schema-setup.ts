/** Creates a table with the main-table schema; used for DynamoDB Local and integration tests. */
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  type DynamoDBClient,
  ListTablesCommand,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import { MAIN_TABLE } from './schema.ts';

export async function waitForDynamo(client: DynamoDBClient, attempts = 30): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.send(new ListTablesCommand({}));
      return;
    } catch (e) {
      if (attempt >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** Creates the table unless it exists; returns whether it was created. */
export async function ensureTable(client: DynamoDBClient, tableName: string): Promise<boolean> {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return false;
  } catch (e) {
    if (!(e instanceof ResourceNotFoundException)) throw e;
  }
  const keys = [
    MAIN_TABLE.partitionKey,
    MAIN_TABLE.sortKey,
    ...MAIN_TABLE.indexes.flatMap((i) => [i.partitionKey, i.sortKey]),
  ];
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: keys.map((name) => ({ AttributeName: name, AttributeType: 'S' })),
      KeySchema: [
        { AttributeName: MAIN_TABLE.partitionKey, KeyType: 'HASH' },
        { AttributeName: MAIN_TABLE.sortKey, KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: MAIN_TABLE.indexes.map((i) => ({
        IndexName: i.name,
        KeySchema: [
          { AttributeName: i.partitionKey, KeyType: 'HASH' },
          { AttributeName: i.sortKey, KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      })),
      StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
    }),
  );
  await client.send(
    new UpdateTimeToLiveCommand({
      TableName: tableName,
      TimeToLiveSpecification: { AttributeName: MAIN_TABLE.ttlAttribute, Enabled: true },
    }),
  );
  return true;
}

export async function deleteTable(client: DynamoDBClient, tableName: string): Promise<void> {
  await client.send(new DeleteTableCommand({ TableName: tableName }));
}
