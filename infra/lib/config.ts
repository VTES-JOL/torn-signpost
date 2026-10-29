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
  /**
   * GitHub OIDC immutable subject prefix (owner and repo IDs), so a renamed or re-created repo
   * can't assume the deploy role.
   */
  githubOidcSubject: string;
  monthlyBudgetUsd: number;
  /**
   * SSM parameter holding the budget/alarm email. Resolved by CloudFormation at deploy time, so the
   * address never appears in the public repo or CI logs.
   */
  alertEmailParameter: string;
  /** Feature flags served to clients; keeps unfinished features dark on the live beta. */
  flags: Record<string, boolean>;
  /** Server-side switch for the game service (M2); off until the web tabletop (M4) is ready. */
  gamesEnabled: boolean;
}

export const beta: StageConfig = {
  stage: 'beta',
  region: 'us-east-1',
  domainName: 'tornsignpost.org',
  hostedZoneId: 'Z05649391VI7WDPTZYFVB',
  githubRepo: 'VTES-JOL/torn-signpost',
  githubOidcSubject: 'repo:VTES-JOL@200019109/torn-signpost@1438320358',
  monthlyBudgetUsd: 50,
  alertEmailParameter: '/torn-signpost/beta/alert-email',
  flags: {},
  gamesEnabled: false,
};

export const hosts = (c: StageConfig) => ({
  web: c.domainName,
  api: `api.${c.domainName}`,
  ws: `ws.${c.domainName}`,
  auth: `auth.${c.domainName}`,
  content: `content.${c.domainName}`,
});

export const stackName = (c: StageConfig, name: string) =>
  `TornSignpost-${c.stage[0]?.toUpperCase()}${c.stage.slice(1)}-${name}`;
