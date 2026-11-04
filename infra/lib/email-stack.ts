import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ses from 'aws-cdk-lib/aws-ses';
import type { Construct } from 'constructs';
import type { StageConfig } from './config.ts';

/**
 * Email notifications through SES (NOTIF-02, docs/m5b-plan.md, increment 0): the domain identity
 * with Easy DKIM, a custom MAIL FROM subdomain (its MX and SPF records are created with it), a
 * DMARC record, and a configuration set that keeps bounced and complaining addresses on the
 * account's suppression list so they are never mailed again.
 *
 * SES starts in the sandbox (verified recipients only). Production access is requested by hand in
 * the console; see the README.
 */
export class EmailStack extends Stack {
  readonly identity: ses.EmailIdentity;
  readonly configurationSet: ses.ConfigurationSet;
  readonly fromAddress: string;

  constructor(scope: Construct, id: string, config: StageConfig, props?: StackProps) {
    super(scope, id, props);
    const zone = route53.PublicHostedZone.fromPublicHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: config.hostedZoneId,
      zoneName: config.domainName,
    });

    this.configurationSet = new ses.ConfigurationSet(this, 'Notifications', {
      reputationMetrics: true,
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });

    this.identity = new ses.EmailIdentity(this, 'Domain', {
      identity: ses.Identity.publicHostedZone(zone),
      mailFromDomain: `mail.${config.domainName}`,
      configurationSet: this.configurationSet,
    });

    // Only SES sends mail for the domain, so a reporting-only policy costs nothing and can be
    // tightened to quarantine once delivery has been watched for a while.
    new route53.TxtRecord(this, 'Dmarc', {
      zone,
      recordName: `_dmarc.${config.domainName}`,
      values: ['v=DMARC1; p=none; adkim=r; aspf=r'],
      ttl: Duration.hours(1),
    });

    this.fromAddress = `notifications@${config.domainName}`;
    new CfnOutput(this, 'FromAddress', { value: this.fromAddress });
    new CfnOutput(this, 'ConfigurationSetName', {
      value: this.configurationSet.configurationSetName,
    });
  }
}
