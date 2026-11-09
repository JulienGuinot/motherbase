import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import express from 'express';
import { asValue, createContainer } from 'awilix';
import { controller, scopePerRequest } from 'awilix-express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { createClient, type MotherbaseClient } from '@motherbase/client';
import prisma from '../lib/prisma';
import container from '../container';
import { StorageService } from '../services/storage/storage.service';
import { BucketService } from '../services/storage/bucket.service';
import { ImageRenderService } from '../services/storage/image-render.service';
import { LocalStorageDriver } from '../services/storage/local.driver';
import { ApiKeyService } from '../services/api-key.service';
import FileController from '../controllers/file.controller';
import StorageBucketController from '../controllers/storage-bucket.controller';
import StorageRenderController from '../controllers/storage-render.controller';
import { FileStore } from '@tus/file-store';
import { S3Store } from '@tus/s3-store';
import { ResumableUploadService, RESUMABLE_CHUNK_BYTES } from '../services/storage/resumable-upload.service';
import { registerStorageProtocolRoutes, RESUMABLE_UPLOAD_PATH } from '../lib/storage-protocol-routes';
import { env } from '../config/env';
import { createApiErrorHandler } from '../middlewares/api-error.middleware';
import { requestId } from '../middlewares/request-id.middleware';

// Supabase storage parity over real HTTP: bucket limits and image transforms
// through the SDK, against Postgres and the local driver's bytes on disk.
const stamp = Date.now();
const publicSlug = `parity-pub-${stamp}`;
const privateSlug = `parity-priv-${stamp}`;
let settings: Record<string, unknown> = {};
let server: Server;
let baseUrl: string;
let storageRoot: string;
let secretId: string;
let secretKey: string;
let secret: MotherbaseClient;
let resumable: ResumableUploadService;
let restore: () => void;

async function png(width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await sharp({ create: { width, height, channels: 3, background: '#ff6600' } }).png().toBuffer());
}

beforeAll(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'motherbase-storage-parity-'));
  const settingsService = { get: async (name: string) => settings[name] ?? {} };
  const buckets = new BucketService({ prisma } as any);
  vi.spyOn(buckets, 'dispatchWebhook').mockResolvedValue(undefined);
  const storage = new StorageService({ prisma, BucketService: buckets, SettingsService: settingsService } as any);
  (storage as any).driver = new LocalStorageDriver(storageRoot);
  const render = new ImageRenderService({ StorageService: storage, BucketService: buckets, SettingsService: settingsService } as any);
  resumable = new ResumableUploadService({ StorageService: storage } as any);
  const keys = new ApiKeyService({ prisma } as any);
  const key = await keys.create('storage-parity', 'secret');
  secretId = key.id;
  secretKey = key.clearToken;
  const originalResolve = container.resolve.bind(container);
  const spy = vi.spyOn(container, 'resolve').mockImplementation(((name: string) => {
    if (name === 'ApiKeyService') return keys;
    if (name === 'SettingsService') return settingsService;
    if (name === 'BucketService') return buckets;
    if (name === 'StorageService') return storage;
    return originalResolve(name);
  }) as typeof container.resolve);
  restore = () => spy.mockRestore();

  const app = express();
  app.use(requestId);
  registerStorageProtocolRoutes(app, {
    resumable: () => resumable,
    s3: () => { throw new Error('the S3 protocol is not under test here'); },
  });
  app.use(express.json());
  app.use(scopePerRequest(createContainer().register({
    StorageService: asValue(storage), BucketService: asValue(buckets), ImageRenderService: asValue(render),
  })));
  app.use(controller([StorageBucketController, FileController, StorageRenderController]));
  app.use(createApiErrorHandler({ isProduction: true }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  secret = createClient(baseUrl, key.clearToken);
  expect((await secret.storage.createBucket(publicSlug, { public: true })).error).toBeNull();
  expect((await secret.storage.createBucket(privateSlug, {
    fileSizeLimit: '1KB',
    allowedMimeTypes: ['image/*'],
  })).error).toBeNull();
}, 30_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  restore?.();
  const created = await prisma.bucket.findMany({ where: { slug: { in: [publicSlug, privateSlug] } } });
  await prisma.file.deleteMany({ where: { bucketId: { in: created.map(b => b.id) } } });
  await prisma.bucket.deleteMany({ where: { id: { in: created.map(b => b.id) } } });
  if (secretId) await prisma.projectApiKey.delete({ where: { id: secretId } });
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

describe('bucket limits through the SDK', () => {
  it('reports and enforces file_size_limit and allowed_mime_types', async () => {
    const info = await secret.storage.getBucket(privateSlug);
    expect(info.data).toMatchObject({ file_size_limit: 1024, allowed_mime_types: ['image/*'] });

    const bucket = secret.storage.from(privateSlug);
    expect((await bucket.upload('a.txt', new Blob(['hi'], { type: 'text/plain' }))).error).toMatchObject({ status: 400 });
    expect((await bucket.upload('big.png', new Blob([new Uint8Array(2048)], { type: 'image/png' }))).error).toMatchObject({ status: 400 });
    expect((await bucket.upload('ok.png', new Blob([new Uint8Array(10)], { type: 'image/png' }))).error).toBeNull();

    expect((await secret.storage.updateBucket(privateSlug, { fileSizeLimit: null, allowedMimeTypes: null })).data)
      .toMatchObject({ file_size_limit: null, allowed_mime_types: null });
  });
});

describe('image transformations', () => {
  it('serves a public render URL, an authenticated download and a signed URL', async () => {
    const bucket = secret.storage.from(publicSlug);
    expect((await bucket.upload('photos/wide.png', new Blob([await png(400, 200)], { type: 'image/png' }))).error).toBeNull();

    const { publicUrl } = bucket.getPublicUrl('photos/wide.png', { transform: { width: 100, height: 100, resize: 'contain' } }).data;
    expect(publicUrl).toContain('/storage/v1/render/image/public/');
    const res = await fetch(publicUrl, { headers: { Accept: 'image/webp' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const rendered = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect([rendered.width, rendered.height]).toEqual([100, 50]);

    const downloaded = await bucket.download('photos/wide.png', { transform: { width: 40, format: 'origin' } });
    expect(downloaded.error).toBeNull();
    expect((await sharp(Buffer.from(await downloaded.data!.arrayBuffer())).metadata()).width).toBe(40);

    const signed = await bucket.createSignedUrl('photos/wide.png', 60, { transform: { width: 20 } });
    expect(signed.error).toBeNull();
    expect(signed.data?.expiresAt).not.toBeNull();
    // Signed URLs are absolute on BASE_HOST; this server listens elsewhere.
    const { pathname, search } = new URL(signed.data!.signedUrl);
    expect(pathname).toBe(`/storage/v1/render/image/sign/${publicSlug}/photos/wide.png`);
    expect((await fetch(`${baseUrl}${pathname}${search}`)).status).toBe(200);
    // The signature covers the transform: the same token at another size fails.
    expect((await fetch(`${baseUrl}${pathname}${search.replace('width=20', 'width=2000')}`)).status).toBe(400);
  });

  it('refuses private buckets on the public route and honours the project switch', async () => {
    const privateBucket = secret.storage.from(privateSlug);
    expect((await privateBucket.upload('p.png', new Blob([await png(10, 10)], { type: 'image/png' }))).error).toBeNull();
    expect((await fetch(privateBucket.getPublicUrl('p.png', { transform: { width: 5 } }).data.publicUrl)).status).toBe(404);

    settings = { 'storage.imageTransform': { enabled: false } };
    try {
      const res = await fetch(secret.storage.from(publicSlug).getPublicUrl('photos/wide.png', { transform: { width: 10 } }).data.publicUrl);
      expect(res.status).toBe(403);
    } finally {
      settings = {};
    }
  });
});

/** Supabase's metadata encoding: comma-separated `key base64(value)` pairs. */
const tusMetadata = (values: Record<string, string>) =>
  Object.entries(values).map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`).join(',');

function tus(url: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  return fetch(url.startsWith('http') ? url : `${baseUrl}${url}`, {
    ...init,
    headers: { 'Tus-Resumable': '1.0.0', apikey: secretKey, ...init.headers },
  });
}

// Both staging stores, because they differ in exactly the places that break:
// S3 multipart part sizes, and where the local store keeps its bookkeeping.
const stores = [
  { name: 'local file store', make: () => ({ prefix: '', store: new FileStore({ directory: path.join(storageRoot, '.resumable'), expirationPeriodInMilliseconds: 86_400_000 }) }) },
  ...(env.S3_ENDPOINT ? [{
    name: 'S3 store (MinIO)',
    make: () => ({ prefix: '.resumable/', store: new S3Store({
      partSize: RESUMABLE_CHUNK_BYTES,
      expirationPeriodInMilliseconds: 86_400_000,
      s3ClientConfig: {
        bucket: env.S3_BUCKET || 'uploads', region: env.S3_REGION, endpoint: env.S3_ENDPOINT, forcePathStyle: true,
        credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
      },
    }) }),
  }] : []),
];

describe.each(stores)('resumable uploads (TUS 1.0.0) on the $name', ({ make }) => {
  beforeAll(() => {
    // A fresh service per store: tus servers are built once per service.
    resumable = new ResumableUploadService((resumable as any).di);
    (resumable as any).staging = make();
  });

  it('creates, reports offsets, resumes, and lands the object where the metadata said', async () => {
    const bytes = Buffer.alloc(RESUMABLE_CHUNK_BYTES + 1234, 7);
    const objectName = `big/${Math.random().toString(36).slice(2)}.bin`;
    const created = await tus(RESUMABLE_UPLOAD_PATH, {
      method: 'POST',
      headers: {
        'Upload-Length': String(bytes.length),
        'Upload-Metadata': tusMetadata({ bucketName: publicSlug, objectName, contentType: 'application/octet-stream' }),
      },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('upload-expires')).toBeTruthy();
    const location = created.headers.get('location')!;
    expect(location).toMatch(new RegExp(`${RESUMABLE_UPLOAD_PATH}/[0-9a-f-]{36}$`));
    const uploadUrl = `${RESUMABLE_UPLOAD_PATH}/${location.split('/').pop()}`;

    const patch = (offset: number, chunk: Buffer) => tus(uploadUrl, {
      method: 'PATCH',
      headers: { 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' },
      body: new Uint8Array(chunk),
    });
    const first = await patch(0, bytes.subarray(0, RESUMABLE_CHUNK_BYTES));
    expect(first.status).toBe(204);
    expect(first.headers.get('upload-offset')).toBe(String(RESUMABLE_CHUNK_BYTES));

    // The client lost track, asks where it stands, and a stale offset is refused.
    const head = await tus(uploadUrl, { method: 'HEAD' });
    expect(head.headers.get('upload-offset')).toBe(String(RESUMABLE_CHUNK_BYTES));
    expect(head.headers.get('upload-length')).toBe(String(bytes.length));
    expect((await patch(0, bytes.subarray(0, 10))).status).toBe(409);

    expect((await patch(RESUMABLE_CHUNK_BYTES, bytes.subarray(RESUMABLE_CHUNK_BYTES))).status).toBe(204);
    const downloaded = await secret.storage.from(publicSlug).download(objectName);
    expect(Buffer.from(await downloaded.data!.arrayBuffer()).equals(bytes)).toBe(true);
    // The staged copy is gone once the object has landed.
    expect((await tus(uploadUrl, { method: 'HEAD' })).status).toBe(404);
  });

  it('refuses at creation what the final write would refuse', async () => {
    await secret.storage.updateBucket(privateSlug, { fileSizeLimit: '1KB', allowedMimeTypes: ['image/*'] });
    try {
      const create = (headers: Record<string, string>, meta: Record<string, string>) =>
        tus(RESUMABLE_UPLOAD_PATH, { method: 'POST', headers: { 'Upload-Metadata': tusMetadata(meta), ...headers } });

      const wrongType = await create({ 'Upload-Length': '10' }, { bucketName: privateSlug, objectName: 'x.txt', contentType: 'text/plain' });
      expect(wrongType.status).toBe(400);
      expect(await wrongType.text()).toMatch(/not allowed/);
      expect((await create({ 'Upload-Length': '4096' }, { bucketName: privateSlug, objectName: 'x.png', contentType: 'image/png' })).status).toBe(400);
      expect((await create({ 'Upload-Defer-Length': '1' }, { bucketName: privateSlug, objectName: 'x.png', contentType: 'image/png' })).status).toBe(400);
      expect((await create({ 'Upload-Length': '10' }, { bucketName: privateSlug })).status).toBe(400);

      // An existing key is a conflict unless the caller asked for an upsert.
      const taken = `taken-${Math.random().toString(36).slice(2)}.png`;
      expect((await secret.storage.from(privateSlug).upload(taken, new Blob([new Uint8Array(4)], { type: 'image/png' }))).error).toBeNull();
      const meta = { bucketName: privateSlug, objectName: taken, contentType: 'image/png' };
      expect((await create({ 'Upload-Length': '4' }, meta)).status).toBe(409);
      expect((await create({ 'Upload-Length': '4', 'x-upsert': 'true' }, meta)).status).toBe(201);
    } finally {
      await secret.storage.updateBucket(privateSlug, { fileSizeLimit: null, allowedMimeTypes: null });
    }
  });

  it('requires a caller, like every other storage route', async () => {
    const res = await fetch(`${baseUrl}${RESUMABLE_UPLOAD_PATH}`, {
      method: 'POST',
      headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': '1', 'Upload-Metadata': tusMetadata({ bucketName: publicSlug, objectName: 'a' }) },
    });
    expect(res.status).toBe(401);
  });
});
