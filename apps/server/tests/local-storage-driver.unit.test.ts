import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { FileVisibility } from '@prisma/client';
import { LocalStorageDriver } from '../services/storage/local.driver';

describe('LocalStorageDriver async I/O', () => {
  let root: string;
  let driver: LocalStorageDriver;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mb-local-storage-'));
    driver = new LocalStorageDriver(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes, reads, stats, and deletes objects asynchronously', async () => {
    await driver.put({
      bucket: 'private',
      key: 'nested/object.txt',
      body: Readable.from('payload'),
      contentLength: 7,
      visibility: FileVisibility.private,
    });

    const object = await driver.getObject('private', 'nested/object.txt');
    const chunks: Buffer[] = [];
    for await (const chunk of object.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('payload');
    expect(object.contentLength).toBe(7);
    expect(await driver.headObject('private', 'nested/object.txt')).toEqual({ contentLength: 7 });

    await driver.delete('private', 'nested/object.txt');
    await expect(driver.getObject('private', 'nested/object.txt')).rejects.toMatchObject({ statusCode: 404 });
    await expect(driver.delete('private', 'nested/object.txt')).resolves.toBeUndefined();
  });

  it('removes partial objects when the upload source fails', async () => {
    const failingSource = Readable.from(
      (async function* () {
        yield Buffer.from('partial');
        throw new Error('source interrupted');
      })()
    );

    await expect(
      driver.put({
        bucket: 'private',
        key: 'failed.bin',
        body: failingSource,
        contentLength: 20,
        visibility: FileVisibility.private,
      })
    ).rejects.toThrow('source interrupted');

    expect(await fs.readdir(path.join(root, 'private'))).toEqual([]);
    await expect(driver.getObject('private', 'failed.bin')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('maps missing reads and metadata to the existing 404 contract', async () => {
    await expect(driver.getObject('private', 'missing')).rejects.toMatchObject({
      statusCode: 404,
      message: 'Object not found',
    });
    await expect(driver.headObject('private', 'missing')).rejects.toMatchObject({
      statusCode: 404,
      message: 'Object not found',
    });
  });

  it('keeps path traversal outside the storage root rejected', async () => {
    await expect(
      driver.put({
        bucket: 'private',
        key: '../../../outside-storage-root',
        body: Readable.from('blocked'),
        contentLength: 7,
        visibility: FileVisibility.private,
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('contains no synchronous filesystem calls in request-path methods', async () => {
    const source = await fs.readFile(path.resolve(__dirname, '../services/storage/local.driver.ts'), 'utf8');
    expect(source).not.toMatch(/\b(?:exists|mkdir|readFile|writeFile|unlink|stat)Sync\(/);
  });
});
