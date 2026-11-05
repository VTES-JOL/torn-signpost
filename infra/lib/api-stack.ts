import { fileURLToPath } from 'node:url';
import { ArnFormat, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import {
  HttpLambdaIntegration,
  WebSocketLambdaIntegration,
} from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { hosts, type StageConfig } from './config.ts';

const repoPath = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

export interface ApiStackProps extends StackProps {
  zone: route53.IHostedZone;
  certificate: acm.ICertificate;
  table: dynamodb.ITableV2;
  userPoolId: string;
  userPoolClientId: string;
  version: string;
  /** The SES set-up (EmailStack), for email notifications (NOTIF-02). */
  email: { identityArn: string; configurationSetName: string; fromAddress: string };
}

/**
 * HTTP API on api.<domain> (architecture §5.1, AD-06) and the WebSocket API on ws.<domain> for
 * live game updates (§5.4), each backed by its own Lambda.
 */
export class ApiStack extends Stack {
  readonly url: string;
  readonly wsUrl: string;
  readonly apiFunction: nodejs.NodejsFunction;
  readonly wsFunction: nodejs.NodejsFunction;
  readonly timersFunction: nodejs.NodejsFunction;
  readonly timersDeadLetters: sqs.Queue;
  readonly httpApi: apigw.HttpApi;

  constructor(scope: Construct, id: string, config: StageConfig, props: ApiStackProps) {
    super(scope, id, props);
    const h = hosts(config);
    this.url = `https://${h.api}`;
    this.wsUrl = `wss://${h.ws}`;

    const environment = {
      STAGE: config.stage,
      APP_VERSION: props.version,
      TABLE_NAME: props.table.tableName,
      USER_POOL_ID: props.userPoolId,
      USER_POOL_CLIENT_ID: props.userPoolClientId,
      GAMES_ENABLED: String(config.gamesEnabled),
      PRESENCE_ENABLED: String(config.presenceEnabled),
      CONTENT_URL: `https://${h.content}`,
      NODE_OPTIONS: '--enable-source-maps',
    };
    const fn = (
      name: string,
      entry: string,
      extra: Record<string, string> = {},
      functionName?: string,
    ) => {
      const f = new nodejs.NodejsFunction(this, `${name}Function`, {
        ...(functionName ? { functionName } : {}),
        entry: repoPath(entry),
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
        environment: { ...environment, ...extra },
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
        }),
      });
      props.table.grantReadWriteData(f);
      return f;
    };

    // WebSocket API (§5.4). Its Lambda derives the callback URL from each request, because the API
    // can't be passed to its own integration's environment without a circular dependency.
    this.wsFunction = fn('Ws', 'services/backend/src/lambda/ws.ts');
    const wsIntegration = (name: string) => new WebSocketLambdaIntegration(name, this.wsFunction);
    const wsApi = new apigw.WebSocketApi(this, 'WsApi', {
      apiName: `torn-signpost-${config.stage}-ws`,
      connectRouteOptions: { integration: wsIntegration('WsConnect') },
      disconnectRouteOptions: { integration: wsIntegration('WsDisconnect') },
      defaultRouteOptions: { integration: wsIntegration('WsMessage') },
    });
    const wsDomain = new apigw.DomainName(this, 'WsDomain', {
      domainName: h.ws,
      certificate: props.certificate,
    });
    const wsStage = new apigw.WebSocketStage(this, 'WsStage', {
      webSocketApi: wsApi,
      stageName: 'live',
      autoDeploy: true,
      throttle: { rateLimit: 50, burstLimit: 100 },
      domainMapping: { domainName: wsDomain },
    });
    const manageConnections = (stageArn: string) =>
      new iam.PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [stageArn],
      });
    // Wildcard API ID for the WebSocket Lambda, again to avoid a dependency cycle.
    this.wsFunction.addToRolePolicy(
      manageConnections(
        this.formatArn({
          service: 'execute-api',
          resource: `*/${wsStage.stageName}/POST/@connections/*`,
        }),
      ),
    );

    // One-off timers (docs/m5b-plan.md, design decision 5): EventBridge Scheduler schedules that
    // invoke the timers Lambda once and delete themselves. Presence checks now; deadlines later.
    // The timers function has a fixed name so the WebSocket Lambda can target it by ARN without a
    // dependency cycle (the timers Lambda pushes through the WebSocket API).
    const timersName = `torn-signpost-${config.stage}-timers`;
    const timersArn = this.formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName: timersName,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    const scheduleGroup = new scheduler.CfnScheduleGroup(this, 'TimersGroup', {
      name: `torn-signpost-${config.stage}`,
    });
    this.timersDeadLetters = new sqs.Queue(this, 'TimersDeadLetters', {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    });
    schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [timersArn, `${timersArn}:*`],
      }),
    );
    this.timersDeadLetters.grantSendMessages(schedulerRole);
    const timerEnv = {
      SCHEDULER_GROUP: scheduleGroup.name ?? '',
      SCHEDULER_ROLE_ARN: schedulerRole.roleArn,
      TIMERS_FUNCTION_ARN: timersArn,
      TIMERS_DLQ_ARN: this.timersDeadLetters.queueArn,
    };
    const canSchedule = (f: lambda.Function) => {
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            'scheduler:CreateSchedule',
            'scheduler:UpdateSchedule',
            'scheduler:DeleteSchedule',
          ],
          resources: [
            this.formatArn({
              service: 'scheduler',
              resource: 'schedule',
              resourceName: `${scheduleGroup.name}/*`,
            }),
          ],
        }),
      );
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [schedulerRole.roleArn],
          conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
        }),
      );
    };
    for (const [k, v] of Object.entries(timerEnv)) this.wsFunction.addEnvironment(k, v);
    canSchedule(this.wsFunction);

    this.timersFunction = fn(
      'Timers',
      'services/backend/src/lambda/timers.ts',
      { WS_CALLBACK_URL: wsStage.callbackUrl, ...timerEnv },
      timersName,
    );
    canSchedule(this.timersFunction);
    this.timersFunction.addToRolePolicy(
      manageConnections(
        this.formatArn({
          service: 'execute-api',
          resource: `${wsApi.apiId}/${wsStage.stageName}/POST/@connections/*`,
        }),
      ),
    );

    // Commands schedule deadline, time-limit and pause checks (docs/m5b-plan.md increment 3).
    this.apiFunction = fn('Api', 'services/backend/src/lambda/api.ts', {
      ALLOWED_ORIGINS: [`https://${h.web}`, 'http://localhost:5173'].join(','),
      WS_CALLBACK_URL: wsStage.callbackUrl,
      ...timerEnv,
    });
    canSchedule(this.apiFunction);
    this.apiFunction.addToRolePolicy(
      manageConnections(
        this.formatArn({
          service: 'execute-api',
          resource: `${wsApi.apiId}/${wsStage.stageName}/POST/@connections/*`,
        }),
      ),
    );

    // Email notifications (NOTIF-02, docs/m5b-plan.md increment 6). Every Lambda builds the same
    // services, so all get the settings; only the timers Lambda sends (delayed emails, digests).
    const unsubscribeSecret = new secretsmanager.Secret(this, 'UnsubscribeSecret', {
      description: 'Signs one-click unsubscribe links in notification emails',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    const emailEnv = {
      EMAIL_ENABLED: String(config.emailEnabled),
      EMAIL_FROM: props.email.fromAddress,
      EMAIL_CONFIGURATION_SET: props.email.configurationSetName,
      WEB_URL: `https://${h.web}`,
      API_URL: this.url,
      UNSUBSCRIBE_SECRET_ARN: unsubscribeSecret.secretArn,
    };
    for (const f of [this.wsFunction, this.apiFunction, this.timersFunction]) {
      for (const [k, v] of Object.entries(emailEnv)) f.addEnvironment(k, v);
      unsubscribeSecret.grantRead(f);
    }
    this.timersFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [
          props.email.identityArn,
          this.formatArn({
            service: 'ses',
            resource: 'configuration-set',
            resourceName: props.email.configurationSetName,
          }),
        ],
      }),
    );
    // Digests at 05:00 and 17:00 UTC; daily ones only go out in the evening.
    for (const [slot, hour] of [
      ['morning', 5],
      ['evening', 17],
    ] as const) {
      new scheduler.CfnSchedule(this, `Digest${slot[0]?.toUpperCase()}${slot.slice(1)}`, {
        groupName: scheduleGroup.name ?? 'default',
        scheduleExpression: `cron(0 ${hour} * * ? *)`,
        scheduleExpressionTimezone: 'UTC',
        flexibleTimeWindow: { mode: 'FLEXIBLE', maximumWindowInMinutes: 15 },
        target: {
          arn: timersArn,
          roleArn: schedulerRole.roleArn,
          input: JSON.stringify({ kind: 'digest', slot }),
          deadLetterConfig: { arn: this.timersDeadLetters.queueArn },
          retryPolicy: { maximumRetryAttempts: 2 },
        },
      }).addResourceDependency(scheduleGroup);
    }

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

    for (const [recordId, host, domain] of [
      ['ApiA', h.api, domainName],
      ['WsA', h.ws, wsDomain],
    ] as const) {
      new route53.ARecord(this, recordId, {
        zone: props.zone,
        recordName: host,
        target: route53.RecordTarget.fromAlias(
          new targets.ApiGatewayv2DomainProperties(
            domain.regionalDomainName,
            domain.regionalHostedZoneId,
          ),
        ),
      });
    }
  }
}
