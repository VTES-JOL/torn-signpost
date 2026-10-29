import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { hosts, type StageConfig } from './config.ts';

/** SPA routing: extensionless paths serve index.html; real files pass through. */
const SPA_REWRITE = `function handler(event) {
  var req = event.request;
  if (req.uri.indexOf('.') === -1) { req.uri = '/index.html'; }
  return req;
}`;

/**
 * Long-lived resources: DNS/certificate, the main table, the web distribution and the content
 * pack distribution (architecture §5.3, §5.5, AD-08). Everything stateful is retained on delete.
 */
export class FoundationStack extends Stack {
  readonly zone: route53.IHostedZone;
  readonly certificate: acm.ICertificate;
  readonly table: dynamodb.TableV2;
  readonly webBucket: s3.Bucket;
  readonly webDistribution: cloudfront.Distribution;
  readonly contentBucket: s3.Bucket;

  constructor(scope: Construct, id: string, config: StageConfig, props?: StackProps) {
    super(scope, id, props);
    const h = hosts(config);

    this.zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: config.hostedZoneId,
      zoneName: config.domainName,
    });

    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: config.domainName,
      subjectAlternativeNames: [`*.${config.domainName}`],
      validation: acm.CertificateValidation.fromDns(this.zone),
    });

    // Single table design (architecture §5.3). GSIs are added as access patterns land.
    this.table = new dynamodb.TableV2(this, 'MainTable', {
      tableName: `ts-${config.stage}-main`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: 'ttl',
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1',
          partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
        },
      ],
    });

    // Web app
    this.webBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.webDistribution = new cloudfront.Distribution(this, 'WebDistribution', {
      comment: `Torn Signpost web (${config.stage})`,
      domainNames: [h.web],
      certificate: this.certificate,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: new cloudfront.Function(this, 'SpaRewrite', {
              code: cloudfront.FunctionCode.fromInline(SPA_REWRITE),
              runtime: cloudfront.FunctionRuntime.JS_2_0,
            }),
          },
        ],
      },
    });
    this.aliasRecords('Web', h.web, this.webDistribution);

    // Content pack: WoD material lives here only, never in the repo (LEGAL-08). Content files are
    // immutable and hash-named, so they are cached for a long time.
    this.contentBucket = new s3.Bucket(this, 'ContentBucket', {
      bucketName: `ts-${config.stage}-content-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const contentDistribution = new cloudfront.Distribution(this, 'ContentDistribution', {
      comment: `Torn Signpost content pack (${config.stage})`,
      domainNames: [h.content],
      certificate: this.certificate,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.contentBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: new cloudfront.CachePolicy(this, 'ContentCache', {
          defaultTtl: Duration.days(1),
          maxTtl: Duration.days(365),
          // The card data is ~2 MB of JSON; compressed it's a fraction of that.
          enableAcceptEncodingGzip: true,
          enableAcceptEncodingBrotli: true,
        }),
        responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'ContentCors', {
          corsBehavior: {
            accessControlAllowOrigins: [`https://${h.web}`, 'http://localhost:5173'],
            accessControlAllowMethods: ['GET', 'HEAD'],
            accessControlAllowHeaders: ['*'],
            accessControlAllowCredentials: false,
            originOverride: true,
          },
        }),
      },
    });
    this.aliasRecords('Content', h.content, contentDistribution);
  }

  private aliasRecords(id: string, name: string, distribution: cloudfront.IDistribution) {
    const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
    new route53.ARecord(this, `${id}A`, { zone: this.zone, recordName: name, target });
    new route53.AaaaRecord(this, `${id}Aaaa`, { zone: this.zone, recordName: name, target });
  }
}
