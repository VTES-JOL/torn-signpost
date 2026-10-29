import { fileURLToPath } from 'node:url';
import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import type { Construct } from 'constructs';
import { hosts, type StageConfig } from './config.ts';

const repoPath = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

export interface ApiStackProps extends StackProps {
  zone: route53.IHostedZone;
  certificate: acm.ICertificate;
  table: dynamodb.ITableV2;
  version: string;
}

/** HTTP API on api.<domain> backed by the `api` Lambda (architecture §5.1, AD-06). */
export class ApiStack extends Stack {
  readonly url: string;
  readonly apiFunction: nodejs.NodejsFunction;
  readonly httpApi: apigw.HttpApi;

  constructor(scope: Construct, id: string, config: StageConfig, props: ApiStackProps) {
    super(scope, id, props);
    const h = hosts(config);
    this.url = `https://${h.api}`;

    this.apiFunction = new nodejs.NodejsFunction(this, 'ApiFunction', {
      entry: repoPath('services/backend/src/lambda/api.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(10),
      depsLockFilePath: repoPath('pnpm-lock.yaml'),
      projectRoot: repoPath(''),
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node24',
        minify: true,
        sourceMap: true,
        mainFields: ['module', 'main'],
      },
      environment: {
        STAGE: config.stage,
        APP_VERSION: props.version,
        ALLOWED_ORIGINS: [`https://${h.web}`, 'http://localhost:5173'].join(','),
        TABLE_NAME: props.table.tableName,
        NODE_OPTIONS: '--enable-source-maps',
      },
      logGroup: new logs.LogGroup(this, 'ApiLogs', { retention: logs.RetentionDays.ONE_MONTH }),
    });
    props.table.grantReadWriteData(this.apiFunction);

    const domainName = new apigw.DomainName(this, 'ApiDomain', {
      domainName: h.api,
      certificate: props.certificate,
    });

    this.httpApi = new apigw.HttpApi(this, 'HttpApi', {
      apiName: `torn-signpost-${config.stage}`,
      defaultIntegration: new HttpLambdaIntegration('ApiIntegration', this.apiFunction),
      defaultDomainMapping: { domainName },
      disableExecuteApiEndpoint: true,
    });

    // Abuse limits (architecture §10); per-route limits are added with real routes.
    const stage = this.httpApi.defaultStage?.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 50, throttlingBurstLimit: 100 };

    new route53.ARecord(this, 'ApiA', {
      zone: props.zone,
      recordName: h.api,
      target: route53.RecordTarget.fromAlias(
        new targets.ApiGatewayv2DomainProperties(
          domainName.regionalDomainName,
          domainName.regionalHostedZoneId,
        ),
      ),
    });
  }
}
