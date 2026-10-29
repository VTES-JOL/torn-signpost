/**
 * Local development settings. The DynamoDB client gets an explicit local endpoint and dummy
 * credentials, so a local run can never reach the real AWS account.
 */
export const local = {
  port: Number(process.env.PORT ?? 3001),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  tableName: process.env.TABLE_NAME ?? 'ts-local-main',
  /** Card data comes from the live content CDN (read-only), which allows localhost. */
  contentUrl: process.env.CONTENT_URL ?? 'https://content.tornsignpost.org',
  dynamodb: {
    endpoint: process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000',
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  },
};
