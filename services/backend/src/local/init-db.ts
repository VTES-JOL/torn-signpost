/** Creates the main table in DynamoDB Local if it doesn't exist yet. */
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import { MAIN_TABLE } from '../db/schema.ts';
import { local } from './env.ts';

const client = new DynamoDBClient(local.dynamodb);

async function waitForDynamo() {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.send(new ListTablesCommand({}));
      return;
    } catch (e) {
      if (attempt >= 30)
        throw new Error(`DynamoDB Local not reachable at ${local.dynamodb.endpoint}: ${e}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function exists(): Promise<boolean> {
  try {
    await client.send(new DescribeTableCommand({ TableName: local.tableName }));
    return true;
  } catch (e) {
    if (e instanceof ResourceNotFoundException) return false;
    throw e;
  }
}

await waitForDynamo();
if (await exists()) {
  console.log(`Table ${local.tableName} already exists`);
} else {
  const keys = [
    MAIN_TABLE.partitionKey,
    MAIN_TABLE.sortKey,
    ...MAIN_TABLE.indexes.flatMap((i) => [i.partitionKey, i.sortKey]),
  ];
  await client.send(
    new CreateTableCommand({
      TableName: local.tableName,
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
      TableName: local.tableName,
      TimeToLiveSpecification: { AttributeName: MAIN_TABLE.ttlAttribute, Enabled: true },
    }),
  );
  console.log(`Created table ${local.tableName}`);
}
