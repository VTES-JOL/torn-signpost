/**
 * Encrypting the Archon tokens we keep (docs/m7-plan.md, design decision 2): an organiser's grant
 * acts for them on their tournament, so its tokens are stored sealed. In AWS, with a KMS key;
 * locally and in tests, with AES-GCM under a fixed key (local data is throwaway).
 *
 * Each sealed value is bound to its tournament (KMS encryption context, AES-GCM additional data),
 * so one can't be moved to another tournament's item.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';

export interface Sealer {
  seal(plain: string, context: string): Promise<string>;
  open(sealed: string, context: string): Promise<string>;
}

export function kmsSealer(keyId: string, client = new KMSClient()): Sealer {
  const ctx = (context: string) => ({ purpose: 'archon-grant', tournament: context });
  return {
    async seal(plain, context) {
      const r = await client.send(
        new EncryptCommand({
          KeyId: keyId,
          Plaintext: Buffer.from(plain, 'utf8'),
          EncryptionContext: ctx(context),
        }),
      );
      return Buffer.from(r.CiphertextBlob ?? new Uint8Array()).toString('base64');
    },
    async open(sealed, context) {
      const r = await client.send(
        new DecryptCommand({
          KeyId: keyId,
          CiphertextBlob: Buffer.from(sealed, 'base64'),
          EncryptionContext: ctx(context),
        }),
      );
      return Buffer.from(r.Plaintext ?? new Uint8Array()).toString('utf8');
    },
  };
}

/** AES-256-GCM under a key derived from `secret`: for local development and tests only. */
export function localSealer(secret = 'torn-signpost-local'): Sealer {
  const key = createHash('sha256').update(secret).digest();
  return {
    async seal(plain, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context));
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
    },
    async open(sealed, context) {
      const raw = Buffer.from(sealed, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}
