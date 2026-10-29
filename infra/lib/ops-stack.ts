import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import type { StageConfig } from './config.ts';

export interface OpsStackProps extends StackProps {
  apiFunction: lambda.IFunction;
  httpApi: apigw.HttpApi;
}

/**
 * Operations: the US$50/month budget (NFR-01), alarms (NFR-09) and the GitHub Actions OIDC deploy
 * role (architecture §9). No long-lived keys.
 */
export class OpsStack extends Stack {
  constructor(scope: Construct, id: string, config: StageConfig, props: OpsStackProps) {
    super(scope, id, props);

    const alerts = new sns.Topic(this, 'Alerts', { displayName: 'Torn Signpost alerts' });
    if (config.alertEmail) alerts.addSubscription(new subs.EmailSubscription(config.alertEmail));

    const notify = (threshold: number, type: 'ACTUAL' | 'FORECASTED') => ({
      notification: {
        notificationType: type,
        comparisonOperator: 'GREATER_THAN',
        threshold,
        thresholdType: 'PERCENTAGE',
      },
      subscribers: config.alertEmail
        ? [{ subscriptionType: 'EMAIL', address: config.alertEmail }]
        : [{ subscriptionType: 'SNS', address: alerts.topicArn }],
    });
    alerts.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish'],
        principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
        resources: [alerts.topicArn],
      }),
    );
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `torn-signpost-${config.stage}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: config.monthlyBudgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        notify(50, 'ACTUAL'),
        notify(80, 'ACTUAL'),
        notify(100, 'ACTUAL'),
        notify(100, 'FORECASTED'),
      ],
    });

    const action = new cwActions.SnsAction(alerts);
    new cloudwatch.Alarm(this, 'ApiErrors', {
      alarmDescription: 'API Lambda errors',
      metric: props.apiFunction.metricErrors({ period: Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(action);
    new cloudwatch.Alarm(this, 'Api5xx', {
      alarmDescription: 'API 5xx responses',
      metric: props.httpApi.metricServerError({ period: Duration.minutes(5) }),
      threshold: 10,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(action);

    // GitHub Actions deploys via OIDC, restricted to this repo's protected `beta` environment.
    const provider = new iam.OpenIdConnectProvider(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });
    const deployRole = new iam.Role(this, 'GitHubDeployRole', {
      roleName: `torn-signpost-${config.stage}-github-deploy`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${config.githubRepo}:environment:${config.stage}`,
        },
      }),
    });
    // Deploys go through the CDK bootstrap roles, which hold the actual permissions.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:aws:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-${this.region}`,
        ],
      }),
    );
  }
}
