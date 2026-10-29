/**
 * Content pack ingest (architecture §5.5, DECK-01/08). Run by an admin with AWS credentials:
 *
 *   pnpm content:ingest                     # build card data into content-pack/ (local only)
 *   pnpm content:ingest --images            # also mirror card scans into the content bucket
 *   pnpm content:ingest --images --publish  # and publish the card data and manifest
 *
 * Card data comes from KRCG; scans are copied from the static.deckserver.net bucket (same AWS
 * account) and resized. Nothing produced here is committed (LEGAL-08).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CloudFrontClient,
  CreateInvalidationCommand,
  ListDistributionsCommand,
} from '@aws-sdk/client-cloudfront';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import {
  type ContentManifest,
  DEFAULT_V5_SETS,
  fromKrcg,
  type KrcgCard,
} from '@torn-signpost/cards';
import sharp from 'sharp';

const KRCG_URL = 'https://static.krcg.org/data/vtes.json';
const SCAN_BUCKET = 'static.deckserver.net';
const SIZES = { thumb: 160, full: 358 } as const;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const IMAGE_CACHE = 'public, max-age=2592000';
const MANIFEST_CACHE = 'public, max-age=300';

const { values } = parseArgs({
  options: {
    stage: { type: 'string', default: 'beta' },
    images: { type: 'boolean', default: false },
    publish: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '12' },
  },
});

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const out = join(root, 'content-pack');
const s3 = new S3Client({ region: 'us-east-1' });

async function main() {
  // 1. Card data
  console.log(`Fetching ${KRCG_URL}`);
  const res = await fetch(KRCG_URL);
  if (!res.ok) throw new Error(`KRCG: HTTP ${res.status}`);
  const lastModified = res.headers.get('last-modified') ?? undefined;
  const raw = (await res.json()) as KrcgCard[];
  const cards = raw
    .map((c) => fromKrcg(c, DEFAULT_V5_SETS))
    .sort((a, b) => Number(a.id) - Number(b.id));
  const body = JSON.stringify(cards);
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 12);
  const cardsPath = `data/cards.${hash}.json`;
  const manifest: ContentManifest = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    source: { name: 'KRCG', url: KRCG_URL, ...(lastModified ? { lastModified } : {}) },
    cards: cardsPath,
    count: cards.length,
    images: {
      pattern: 'cards/{id}/{size}.webp',
      sizes: { ...SIZES },
      backs: { crypt: 'cards/back-crypt/{size}.webp', library: 'cards/back-library/{size}.webp' },
    },
    formats: { v5Sets: DEFAULT_V5_SETS },
  };
  write(cardsPath, body);
  write('data/manifest.json', JSON.stringify(manifest, null, 2));
  const counts = {
    crypt: cards.filter((c) => c.kind === 'crypt').length,
    v5: cards.filter((c) => c.v5).length,
  };
  console.log(
    `${cards.length} cards (${counts.crypt} crypt, ${counts.v5} in the V5 pool) → content-pack/${cardsPath}`,
  );

  if (!values.images && !values.publish) return;
  const account = (
    await new STSClient({ region: 'us-east-1' }).send(new GetCallerIdentityCommand({}))
  ).Account;
  const bucket = `ts-${values.stage}-content-${account}`;

  // 2. Images
  if (values.images)
    await mirrorImages(bucket, [...cards.map((c) => c.id), 'back-crypt', 'back-library']);

  // 3. Publish: immutable card data first, then the manifest that points at it.
  if (values.publish) {
    await put(bucket, cardsPath, body, 'application/json', IMMUTABLE);
    await put(
      bucket,
      'data/manifest.json',
      JSON.stringify(manifest, null, 2),
      'application/json',
      MANIFEST_CACHE,
    );
    await invalidate(
      `content.${values.stage === 'beta' ? '' : `${values.stage}.`}tornsignpost.org`,
    );
    console.log(`Published ${cardsPath} and data/manifest.json to ${bucket}`);
  }
}

async function mirrorImages(bucket: string, ids: string[]) {
  const existing = new Set<string>();
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: 'cards/', ContinuationToken: token }),
    );
    for (const o of page.Contents ?? []) if (o.Key) existing.add(o.Key);
    token = page.NextContinuationToken;
  } while (token);

  const todo = ids.filter(
    (id) => values.force || !Object.keys(SIZES).every((s) => existing.has(`cards/${id}/${s}.webp`)),
  );
  console.log(`Images: ${ids.length - todo.length} already mirrored, ${todo.length} to do`);
  let done = 0;
  const missing: string[] = [];
  const broken: string[] = [];
  const worker = async () => {
    for (let id = todo.shift(); id !== undefined; id = todo.shift()) {
      const source = id.startsWith('back-') ? `images/${id.slice(5)}.jpg` : `images/${id}`;
      let scan: Uint8Array;
      try {
        const obj = await s3.send(new GetObjectCommand({ Bucket: SCAN_BUCKET, Key: source }));
        scan = await (
          obj.Body as { transformToByteArray(): Promise<Uint8Array> }
        ).transformToByteArray();
      } catch (e) {
        if ((e as { name?: string }).name !== 'NoSuchKey') throw e;
        missing.push(id);
        continue;
      }
      let images: [string, Buffer][];
      try {
        images = await Promise.all(
          Object.entries(SIZES).map(
            async ([size, width]) =>
              [
                size,
                await sharp(scan)
                  .resize({ width, withoutEnlargement: true })
                  .webp({ quality: 82 })
                  .toBuffer(),
              ] as [string, Buffer],
          ),
        );
      } catch (e) {
        broken.push(`${id} (${String(e).split('\n')[0]})`);
        continue;
      }
      for (const [size, webp] of images) {
        await put(bucket, `cards/${id}/${size}.webp`, webp, 'image/webp', IMAGE_CACHE);
      }
      if (++done % 250 === 0) console.log(`  ${done} images…`);
    }
  };
  await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
  console.log(`Images: mirrored ${done}`);
  if (missing.length) console.log(`  No scan for ${missing.length}: ${missing.join(', ')}`);
  if (broken.length) console.log(`  Unreadable scan for ${broken.length}: ${broken.join('; ')}`);
}

function write(path: string, data: string) {
  const file = join(out, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}

async function put(
  bucket: string,
  key: string,
  body: string | Uint8Array,
  contentType: string,
  cacheControl: string,
) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl,
    }),
  );
}

async function invalidate(alias: string) {
  const cf = new CloudFrontClient({ region: 'us-east-1' });
  const list = await cf.send(new ListDistributionsCommand({}));
  const dist = list.DistributionList?.Items?.find((d) => d.Aliases?.Items?.includes(alias));
  if (!dist?.Id) throw new Error(`No CloudFront distribution for ${alias}`);
  await cf.send(
    new CreateInvalidationCommand({
      DistributionId: dist.Id,
      InvalidationBatch: {
        CallerReference: `ingest-${Date.now()}`,
        Paths: { Quantity: 1, Items: ['/data/manifest.json'] },
      },
    }),
  );
}

await main();
