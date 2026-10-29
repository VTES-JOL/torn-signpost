/**
 * Main table key schema (architecture §5.3). The CDK stack and the local DynamoDB setup both
 * follow this; an infra test checks they agree.
 */
export const MAIN_TABLE = {
  partitionKey: 'PK',
  sortKey: 'SK',
  ttlAttribute: 'ttl',
  indexes: [{ name: 'GSI1', partitionKey: 'GSI1PK', sortKey: 'GSI1SK' }],
} as const;
