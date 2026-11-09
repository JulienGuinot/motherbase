import { createReadStream, createWriteStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import { ByteRange, IStorageDriver, ObjectData, ObjectMetadata, PutObjectInput, encodeObjectPath } from './storage.types';
import { HttpException } from '../../exceptions/http-exception';
import { env } from '../../config/env';
import { logActivity } from '../../lib/activity-log';
import { errorMessage } from '../../lib/errors';

/**
 * Filesystem driver for local development. Objects live under
 * `<STATIC_PATH>/<bucket>/<key>`. Only the public bucket is exposed by the
 * static middleware in app.ts; private objects are streamed through an
 * authenticated endpoint, never via a guessable public URL.
 */
export class LocalStorageDriver implements IStorageDriver {
  private readonly root: string;

  constructor(root = env.STATIC_PATH || 'uploads') {
    this.root = path.resolve(root);
  }

  private static isMissing(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
  }

  /**
   * Resolve the on-disk path and refuse anything that escapes the storage root.
   * Guards against `bucket`/`key` containing `..` or absolute path segments.
   */
  private fullPath(bucket: string, key: string) {
    const target = path.resolve(this.root, bucket, key);
    const base = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (target !== this.root && !target.startsWith(base)) {
      throw new HttpException('Invalid object path', 400);
    }
    return target;
  }

  async put({ bucket, key, body }: PutObjectInput): Promise<void> {
    const filePath = this.fullPath(bucket, key);
    const partialPath = `${filePath}.${randomUUID()}.upload`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await pipeline(body, createWriteStream(partialPath, { flags: 'wx', mode: 0o600 }));
      await fs.rename(partialPath, filePath);
    } catch (error) {
      await fs.unlink(partialPath).catch(cleanupError => {
        if (!LocalStorageDriver.isMissing(cleanupError)) {
          logActivity('error', 'storage', `[storage] failed to remove partial local upload: ${errorMessage(cleanupError)}`);
        }
      });
      throw error;
    }
  }

  async delete(bucket: string, key: string): Promise<void> {
    try {
      await fs.unlink(this.fullPath(bucket, key));
    } catch (error) {
      if (!LocalStorageDriver.isMissing(error)) throw error;
    }
  }

  async getObject(bucket: string, key: string, range?: ByteRange): Promise<ObjectData> {
    const filePath = this.fullPath(bucket, key);
    const stat = await this.readExisting(() => fs.stat(filePath));
    if (!range) return { body: createReadStream(filePath), contentLength: stat.size };
    return { body: createReadStream(filePath, range), contentLength: range.end - range.start + 1 };
  }

  async headObject(bucket: string, key: string): Promise<ObjectMetadata> {
    const stat = await this.readExisting(() => fs.stat(this.fullPath(bucket, key)));
    return { contentLength: stat.size };
  }

  async getSignedDownloadUrl(bucket: string, key: string): Promise<string> {
    return this.publicUrl(bucket, key);
  }

  async getSignedUploadUrl(): Promise<string> {
    throw new HttpException('Presigned uploads are not supported with the local storage driver.', 400);
  }

  publicUrl(bucket: string, key: string): string {
    const host = env.BASE_HOST.startsWith('http') ? env.BASE_HOST : `http://${env.BASE_HOST}`;
    return `${host}/${bucket}/${encodeObjectPath(key)}`;
  }

  private async readExisting<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (LocalStorageDriver.isMissing(error)) throw new HttpException('Object not found', 404);
      throw error;
    }
  }
}
