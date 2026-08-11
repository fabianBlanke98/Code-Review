import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { config } from './config.ts';

// R2 speaks S3. `forcePathStyle` keeps the bucket out of the hostname, which is
// what R2's S3 endpoint expects.
export const s3 = new S3Client({
  region: config.r2.region,
  endpoint: config.r2.endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.r2.accessKeyId,
    secretAccessKey: config.r2.secretAccessKey,
  },
});

export async function download(key: string, destination: string): Promise<void> {
  const result = await s3.send(
    new GetObjectCommand({ Bucket: config.r2.bucket, Key: key }),
  );
  if (!result.Body) throw new Error(`object ${key} has no body`);
  await pipeline(result.Body as Readable, createWriteStream(destination));
}

export async function upload(
  key: string,
  source: string,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: config.r2.bucket,
      Key: key,
      Body: await readFile(source),
      ContentType: contentType,
    }),
  );
}

export async function remove(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: config.r2.bucket, Key: key }));
}

/** Short-lived read URL handed to the app for playback. */
export function signedGetUrl(key: string, expiresInSeconds = 3600): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: config.r2.bucket, Key: key }),
    { expiresIn: expiresInSeconds },
  );
}

/** Short-lived write URL so the device uploads straight to R2, never via us. */
export function signedPutUrl(
  key: string,
  contentType: string,
  expiresInSeconds = 900,
): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: config.r2.bucket, Key: key, ContentType: contentType }),
    { expiresIn: expiresInSeconds },
  );
}
