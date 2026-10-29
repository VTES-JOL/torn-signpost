import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
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
    version: 'test',
  });
  const o = new OpsStack(app, 'O', beta, { env, apiFunction: p.apiFunction, httpApi: p.httpApi });
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
                  'repo:VTES-JOL/torn-signpost:environment:beta',
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
