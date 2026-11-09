import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { Readable, Writable } from 'stream';
import { finished, pipeline } from 'stream/promises';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { env } from '../../config/env';
import { HttpException } from '../../exceptions/http-exception';

export interface RemoteBackup {
  key: string;
  size: number;
  lastModified: string;
}

const DELETE_BATCH_SIZE = 1_000;
const DELETE_CONCURRENCY = 4;

function toReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    return Readable.from(body as AsyncIterable<Uint8Array>);
  }
  throw new HttpException('S3 returned a non-streaming backup body', 502);
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    result.push(items.slice(offset, offset + size));
  }
  return result;
}

async function runBounded<T>(items: T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
  for (const group of chunks(items, concurrency)) {
    const results = await Promise.allSettled(group.map(task));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

/**
 * Builds an S3 client for offsite backups. Uses the dedicated BACKUP_S3_*
 * credentials when present, otherwise falls back to the main S3_* values
 * (same creds, dedicated bucket = the approved design). `forcePathStyle` keeps
 * MinIO / R2 compatible.
 */
function makeBackupS3Client(): S3Client {
  const endpoint = env.BACKUP_S3_ENDPOINT || env.S3_ENDPOINT;
  const region = env.BACKUP_S3_REGION || env.S3_REGION;
  const accessKeyId = env.BACKUP_S3_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.BACKUP_S3_SECRET_ACCESS_KEY || env.S3_SECRET_ACCESS_KEY;
  return new S3Client({
    region,
    endpoint: endpoint || undefined,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
}

/**
 * Thin S3 wrapper scoped to the dedicated backup bucket. Never touches the
 * public bucket. The S3 client is injectable so tests can supply a fake.
 */
export class BackupRemote {
  private readonly client: S3Client;

  constructor(client: S3Client = makeBackupS3Client()) {
    this.client = client;
  }

  /** Dedicated private bucket for backups: guarded against the public bucket. */
  bucket(): string {
    const bucket = env.BACKUP_BUCKET;
    if (bucket && bucket === env.S3_PUBLIC_BUCKET) {
      throw new HttpException('BACKUP_BUCKET must not be the public bucket', 500);
    }
    return bucket;
  }

  async upload(localPath: string, key: string): Promise<void> {
    const stat = await fs.stat(localPath);
    const body = createReadStream(localPath);
    try {
      await this.client.send(
        new PutObjectCommand({ Bucket: this.bucket(), Key: key, Body: body, ContentLength: stat.size })
      );
    } finally {
      body.destroy();
      await finished(body).catch(() => undefined);
    }
  }

  async list(): Promise<RemoteBackup[]> {
    const objects: Array<{ Key?: string; Size?: number; LastModified?: Date }> = [];
    let continuationToken: string | undefined;

    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket(), ContinuationToken: continuationToken })
      );
      objects.push(...(res.Contents ?? []));
      continuationToken = res.NextContinuationToken;
    } while (continuationToken);

    return objects
      .filter(o => !!o.Key)
      .map(o => ({
        key: o.Key as string,
        size: Number(o.Size ?? 0),
        lastModified: (o.LastModified ?? new Date(0)).toISOString(),
      }))
      .sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  }

  async download(key: string, destination: string | Writable): Promise<void> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket(), Key: key }));
    const body = toReadable(res.Body);
    if (typeof destination !== 'string') {
      await pipeline(body, destination);
      return;
    }

    const partialPath = `${destination}.${randomUUID()}.part`;
    try {
      await pipeline(body, createWriteStream(partialPath));
      await fs.rename(partialPath, destination);
    } catch (error) {
      await fs.unlink(partialPath).catch(() => undefined);
      throw error;
    }
  }

  /** Keep the newest `retention` objects; delete the rest. */
  async prune(retention: number): Promise<string[]> {
    const keep = Math.max(0, Math.floor(retention));
    const all = await this.list(); // newest first
    const stale = all.slice(keep);
    const batches = chunks(stale, DELETE_BATCH_SIZE);
    await runBounded(batches, DELETE_CONCURRENCY, async batch => {
      const result = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket(),
          Delete: { Objects: batch.map(({ key }) => ({ Key: key })), Quiet: true },
        })
      );
      if (result.Errors?.length) {
        const failedKeys = result.Errors.map(error => error.Key).filter(Boolean).join(', ');
        throw new HttpException(`Failed to delete remote backups: ${failedKeys}`, 502);
      }
    });
    return stale.map(o => o.key);
  }
}
