import { fileURLToPath } from 'node:url';
import type { ClientConfig } from '@torn-signpost/protocol';
import { Stack, type StackProps } from 'aws-cdk-lib';
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

export interface WebDeployStackProps extends StackProps {
  bucket: s3.IBucket;
  distribution: cloudfront.IDistribution;
  clientConfig: ClientConfig;
}

/**
 * Uploads the built web app plus the runtime /config.json. Separate from the foundation stack so
 * it can depend on the auth and API outputs.
 */
export class WebDeployStack extends Stack {
  constructor(scope: Construct, id: string, props: WebDeployStackProps) {
    super(scope, id, props);

    new s3deploy.BucketDeployment(this, 'WebAssets', {
      destinationBucket: props.bucket,
      sources: [
        s3deploy.Source.asset(fileURLToPath(new URL('../../apps/web/dist', import.meta.url))),
        s3deploy.Source.jsonData('config.json', props.clientConfig),
      ],
      distribution: props.distribution,
      distributionPaths: ['/index.html', '/config.json'],
      prune: true,
      memoryLimit: 512,
    });
  }
}
