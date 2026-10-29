import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export interface DbConfig {
  tableName: string;
  /** Local endpoint (DynamoDB Local); omitted on AWS. */
  endpoint?: string;
}

export function documentClient(config: DbConfig): DynamoDBDocumentClient {
  const client = config.endpoint
    ? new DynamoDBClient({
        endpoint: config.endpoint,
        region: 'us-east-1',
        // Dummy credentials: a local run can never reach the real account.
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      })
    : new DynamoDBClient({});
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}
