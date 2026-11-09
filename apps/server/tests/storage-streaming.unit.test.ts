import fs from 'fs/promises';
import path from 'path';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { FileVisibility } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { sendStorageObject } from '../helpers/storage-stream.helper';
import { S3StorageDriver } from '../services/storage/s3.driver';
import { exactSizeStream } from '../services/storage/sized-stream';

function collectingWritable(chunks: Buffer[], delayMs = 0): Writable {
  return new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      if (delayMs) setTimeout(callback, delayMs);
      else callback();
    },
  });
}

describe('storage streaming primitives', () => {
  it('pipes downloads with metadata and backpressure', async () => {
    const chunks: Buffer[] = [];
    const headers = new Map<string, string | number>();
    const response = collectingWritable(chunks, 1) as Writable & {
      setHeader(name: string, value: string | number): void;
    };
    response.setHeader = (name, value) => void headers.set(name, value);

    await sendStorageObject(response as never, {
      body: Readable.from(['large-', 'object']),
      contentLength: 12,
      mime: 'application/octet-stream',
    });

    expect(Buffer.concat(chunks).toString()).toBe('large-object');
    expect(headers.get('Content-Length')).toBe(12);
    expect(headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it('propagates source errors and rejects truncated or oversized streams', async () => {
    await expect(pipeline(exactSizeStream(Readable.from('short'), 6), collectingWritable([]))).rejects.toThrow(
      'expected 6'
    );
    await expect(pipeline(exactSizeStream(Readable.from('too-long'), 3), collectingWritable([]))).rejects.toThrow(
      'exceeded'
    );

    const failingSource = Readable.from(
      (async function* () {
        yield Buffer.from('partial');
        throw new Error('source interrupted');
      })()
    );
    await expect(pipeline(exactSizeStream(failingSource, 20), collectingWritable([]))).rejects.toThrow(
      'source interrupted'
    );
  });

  it('passes Readable bodies through S3 without materializing them', async () => {
    const download = Readable.from('download');
    const send = vi.fn(async (command: GetObjectCommand | PutObjectCommand) => {
      if (command instanceof GetObjectCommand) {
        return { Body: download, ContentLength: 8, ContentType: 'text/plain' };
      }
      return {};
    });
    const driver = new S3StorageDriver();
    (driver as unknown as { client: { send: typeof send } }).client = { send };

    const object = await driver.getObject('private', 'object');
    expect(object).toMatchObject({ body: download, contentLength: 8, contentType: 'text/plain' });

    const upload = Readable.from('upload');
    await driver.put({
      bucket: 'private',
      key: 'object',
      body: upload,
      contentLength: 6,
      visibility: FileVisibility.private,
    });
    const command = send.mock.calls[1][0] as PutObjectCommand;
    expect(command.input.Body).toBe(upload);
    expect(command.input.ContentLength).toBe(6);
  });

  it('keeps buffering APIs out of application storage request paths', async () => {
    const files = [
      '../helpers/multer.helper.ts',
      '../services/storage/local.driver.ts',
      '../services/storage/s3.driver.ts',
      '../controllers/file.controller.ts',
      '../controllers/storage-public.controller.ts',
      '../controllers/user.controller.ts',
      '../controllers/admin/admin-storage.controller.ts',
    ];
    const source = (await Promise.all(files.map(file => fs.readFile(path.resolve(__dirname, file), 'utf8')))).join(
      '\n'
    );

    expect(source).not.toContain('memoryStorage(');
    expect(source).not.toContain('transformToByteArray(');
    expect(source).not.toMatch(/\b(?:readFile|writeFile)\(/);
    expect(source).not.toContain('.buffer');
  });
});
