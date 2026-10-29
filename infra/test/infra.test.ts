import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { MAIN_TABLE } from '../../services/backend/src/db/schema.ts';
import { ApiStack } from '../lib/api-stack.ts';
import { AuthStack } from '../lib/auth-stack.ts';
import { beta } from '../lib/config.ts';
import { FoundationStack } from '../lib/foundation-stack.ts';
import { OpsStack } from '../lib/ops-stack.ts';

const env = { account: '111111111111', region: 'us-east-1' };
let foundation: Template;
let auth: Template;
let api: Template;
let ops: Template;

beforeAll(() => {
  const app = new App();
  const f = new FoundationStack(app, 'F', beta, { env });
  const a = new AuthStack(app, 'A', beta, { env, zone: f.zone, certificate: f.certificate });
  const p = new ApiStack(app, 'P', beta, {
    env,
    zone: f.zone,
    certificate: f.certificate,
    table: f.table,
    userPoolId: a.userPool.userPoolId,
    userPoolClientId: a.webClient.userPoolClientId,
    version: 'test',
  });
  const o = new OpsStack(app, 'O', beta, {
    env,
    apiFunction: p.apiFunction,
    wsFunction: p.wsFunction,
    httpApi: p.httpApi,
  });
  foundation = Template.fromStack(f);
  auth = Template.fromStack(a);
  api = Template.fromStack(p);
  ops = Template.fromStack(o);
});

describe('foundation', () => {
  it('retains the main table with PITR, streams and deletion protection', () => {
    foundation.hasResource('AWS::DynamoDB::GlobalTable', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        TableName: 'ts-beta-main',
        StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
        Replicas: [
          Match.objectLike({
            DeletionProtectionEnabled: true,
            PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          }),
        ],
      }),
    });
  });

  it('matches the key schema the local DynamoDB setup uses', () => {
    foundation.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      KeySchema: [
        { AttributeName: MAIN_TABLE.partitionKey, KeyType: 'HASH' },
        { AttributeName: MAIN_TABLE.sortKey, KeyType: 'RANGE' },
      ],
      TimeToLiveSpecification: { AttributeName: MAIN_TABLE.ttlAttribute, Enabled: true },
      GlobalSecondaryIndexes: MAIN_TABLE.indexes.map((i) =>
        Match.objectLike({
          IndexName: i.name,
          KeySchema: [
            { AttributeName: i.partitionKey, KeyType: 'HASH' },
            { AttributeName: i.sortKey, KeyType: 'RANGE' },
          ],
        }),
      ),
    });
  });

  it('blocks all public access on every bucket', () => {
    const buckets = foundation.findResources('AWS::S3::Bucket');
    expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(2);
    for (const b of Object.values(buckets)) {
      expect(b.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
  });

  it('retains the content pack bucket (LEGAL-08)', () => {
    foundation.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({ BucketName: Match.stringLikeRegexp('^ts-beta-content-') }),
    });
  });
});

describe('auth', () => {
  it('uses email sign-in with a PKCE public client and no secret', () => {
    auth.hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameAttributes: ['email'],
      DeletionProtection: 'ACTIVE',
    });
    auth.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
    });
  });
});

describe('api', () => {
  it('runs the API on Node.js 24 arm64 with month-long log retention', () => {
    api.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
    });
    api.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });

  it('serves live updates from a throttled WebSocket API on ws.<domain>', () => {
    api.resourceCountIs('AWS::Lambda::Function', 2);
    api.hasResourceProperties('AWS::ApiGatewayV2::Api', { ProtocolType: 'WEBSOCKET' });
    api.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: 'live',
      DefaultRouteSettings: { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 },
    });
    api.hasResourceProperties('AWS::ApiGatewayV2::DomainName', {
      DomainName: 'ws.tornsignpost.org',
    });
  });

  it('keeps games switched off on the beta until the tabletop is ready', () => {
    api.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ GAMES_ENABLED: 'false' }) },
    });
  });

  it('throttles the default stage', () => {
    api.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 },
    });
  });
});

describe('ops', () => {
  it('limits the GitHub deploy role to this repo and the beta environment', () => {
    ops.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [
          Match.objectLike({
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub':
                  'repo:VTES-JOL@200019109/torn-signpost@1438320358:environment:beta',
              },
            },
          }),
        ],
      }),
    });
  });

  it('sets a US$50 monthly budget', () => {
    ops.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 50, Unit: 'USD' }, TimeUnit: 'MONTHLY' }),
    });
  });
});
