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
  archon: {
    url: process.env.ARCHON_URL ?? 'https://archon.krcg.org',
    secretId: process.env.ARCHON_SECRET_ID ?? 'torn-signpost/beta/archon-client',
    client: process.env.ARCHON_CLIENT_SECRET
      ? { id: process.env.ARCHON_CLIENT_ID ?? '', secret: process.env.ARCHON_CLIENT_SECRET }
      : undefined,
  },
  dynamodb: {
    endpoint: process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000',
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  },
};
