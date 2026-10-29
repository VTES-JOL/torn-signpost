import { execSync } from 'node:child_process';
import { App, Tags } from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack.ts';
import { AuthStack } from '../lib/auth-stack.ts';
import { beta, hosts, stackName } from '../lib/config.ts';
import { FoundationStack } from '../lib/foundation-stack.ts';
import { OpsStack } from '../lib/ops-stack.ts';
import { WebDeployStack } from '../lib/web-deploy-stack.ts';

const app = new App();
const config = { ...beta, alertEmail: app.node.tryGetContext('alertEmail') as string | undefined };
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.region };
const version =
  process.env.GITHUB_SHA?.slice(0, 7) ??
  (() => {
    try {
      return execSync('git rev-parse --short HEAD').toString().trim();
    } catch {
      return 'dev';
    }
  })();

const foundation = new FoundationStack(app, stackName(config, 'Foundation'), config, { env });

const auth = new AuthStack(app, stackName(config, 'Auth'), config, {
  env,
  zone: foundation.zone,
  certificate: foundation.certificate,
});
// Cognito custom domains require the parent domain to resolve first.
auth.addStackDependency(foundation);

const api = new ApiStack(app, stackName(config, 'Api'), config, {
  env,
  zone: foundation.zone,
  certificate: foundation.certificate,
  table: foundation.table,
  version,
});

new WebDeployStack(app, stackName(config, 'WebDeploy'), {
  env,
  bucket: foundation.webBucket,
  distribution: foundation.webDistribution,
  clientConfig: {
    stage: config.stage,
    apiUrl: api.url,
    contentUrl: `https://${hosts(config).content}`,
    auth: {
      domain: auth.domainName,
      userPoolId: auth.userPool.userPoolId,
      clientId: auth.webClient.userPoolClientId,
    },
    flags: config.flags,
  },
});

new OpsStack(app, stackName(config, 'Ops'), config, {
  env,
  apiFunction: api.apiFunction,
  httpApi: api.httpApi,
});

Tags.of(app).add('project', 'torn-signpost');
Tags.of(app).add('stage', config.stage);
