import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import type { Construct } from 'constructs';
import { hosts, type StageConfig } from './config.ts';

export interface AuthStackProps extends StackProps {
  zone: route53.IHostedZone;
  certificate: acm.ICertificate;
}

/**
 * Cognito user pool with Managed Login on auth.<domain> (architecture §5.6). Email + password
 * now; Google and Apple identity providers are added once their credentials exist (AUTH-02).
 */
export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly webClient: cognito.UserPoolClient;
  readonly domainName: string;

  constructor(scope: Construct, id: string, config: StageConfig, props: AuthStackProps) {
    super(scope, id, props);
    const h = hosts(config);
    this.domainName = h.auth;

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `torn-signpost-${config.stage}`,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      keepOriginal: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: { minLength: 10, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'admin',
      description: 'Platform administrators and moderators (D14)',
    });

    this.webClient = this.userPool.addClient('WebClient', {
      userPoolClientName: 'web',
      generateSecret: false,
      preventUserExistenceErrors: true,
      authFlows: { user: false, userSrp: false },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`https://${h.web}/auth/callback`, 'http://localhost:5173/auth/callback'],
        logoutUrls: [`https://${h.web}/`, 'http://localhost:5173/'],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    const domain = this.userPool.addDomain('Domain', {
      customDomain: { domainName: h.auth, certificate: props.certificate },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.webClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    new route53.ARecord(this, 'AuthA', {
      zone: props.zone,
      recordName: h.auth,
      target: route53.RecordTarget.fromAlias(new targets.UserPoolDomainTarget(domain)),
    });
  }
}
