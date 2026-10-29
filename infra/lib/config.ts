/**
 * Deployment configuration. One AWS account, one live-beta stage (architecture §9); stack names
 * and domains are derived from `stage` so a staging stage can be added later.
 */
export interface StageConfig {
  stage: string;
  region: string;
  domainName: string;
  hostedZoneId: string;
  githubRepo: string;
  monthlyBudgetUsd: number;
  /**
   * SSM parameter holding the budget/alarm email. Resolved by CloudFormation at deploy time, so the
   * address never appears in the public repo or CI logs.
   */
  alertEmailParameter: string;
  /** Feature flags served to clients; keeps unfinished features dark on the live beta. */
  flags: Record<string, boolean>;
}

export const beta: StageConfig = {
  stage: 'beta',
  region: 'us-east-1',
  domainName: 'tornsignpost.org',
  hostedZoneId: 'Z05649391VI7WDPTZYFVB',
  githubRepo: 'VTES-JOL/torn-signpost',
  monthlyBudgetUsd: 50,
  alertEmailParameter: '/torn-signpost/beta/alert-email',
  flags: {},
};

export const hosts = (c: StageConfig) => ({
  web: c.domainName,
  api: `api.${c.domainName}`,
  auth: `auth.${c.domainName}`,
  content: `content.${c.domainName}`,
});

export const stackName = (c: StageConfig, name: string) =>
  `TornSignpost-${c.stage[0]?.toUpperCase()}${c.stage.slice(1)}-${name}`;
