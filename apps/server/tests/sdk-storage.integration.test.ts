import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import { asValue, createContainer } from 'awilix';
import { controller, scopePerRequest } from 'awilix-express';
import { toNodeHandler } from 'better-auth/node';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { createClient, type MotherbaseClient } from '@motherbase/client';
import prisma from '../lib/prisma';
import container from '../container';
import { RlsPool } from '../lib/rls-pool';
import { StorageService } from '../services/storage/storage.service';
import { StoragePolicyService } from '../services/storage/storage-policy.service';
import { BucketService } from '../services/storage/bucket.service';
import { LocalStorageDriver } from '../services/storage/local.driver';
import { ApiKeyService } from '../services/api-key.service';
import { UserAdminService } from '../services/admin/user-admin.service';
import { createProjectAuth } from '../auth/instance';
import { registerProjectAuthRoutes } from '../auth/routes';
import FileController from '../controllers/file.controller';
import AuthAdminController from '../controllers/auth-admin.controller';
import StorageBucketController from '../controllers/storage-bucket.controller';
import StoragePublicController from '../controllers/storage-public.controller';
import { createApiErrorHandler } from '../middlewares/api-error.middleware';
import { requestId } from '../middlewares/request-id.middleware';

const slug = `sdk-audit-${Date.now()}`;
const pool = new RlsPool();
let policies = false;
let server: Server;
let baseUrl: string;
let storageRoot: string;
let bucketId: string;
let secretId: string;
let secret: MotherbaseClient;
let anon: MotherbaseClient;
let user: MotherbaseClient;
let service: StorageService;
let policyService: StoragePolicyService;
let restore: () => void;
const emails: string[] = [];

beforeAll(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'motherbase-sdk-audit-'));
  const settings = { get: async (name: string) => name === 'storage.policies' ? { enabled: policies } : {} };
  const buckets = new BucketService({ prisma } as any);
  vi.spyOn(buckets, 'dispatchWebhook').mockResolvedValue(undefined);
  policyService = new StoragePolicyService({ RlsPool: pool, SettingsService: settings } as any);
  service = new StorageService({ prisma, BucketService: buckets, SettingsService: settings, StoragePolicyService: policyService } as any);
  (service as any).driver = new LocalStorageDriver(storageRoot);
  const keys = new ApiKeyService({ prisma } as any);
  const key = await keys.create('sdk-audit', 'secret');
  secretId = key.id;
  const originalResolve = container.resolve.bind(container);
  const spy = vi.spyOn(container, 'resolve').mockImplementation(((name: string) => {
    if (name === 'AuthManager') return { current: () => auth };
    if (name === 'ApiKeyService') return keys;
    if (name === 'SettingsService') return settings;
    if (name === 'StoragePolicyService') return policyService;
    if (name === 'BucketService') return buckets;
    return originalResolve(name);
  }) as typeof container.resolve);
  restore = () => spy.mockRestore();
  const app = express();
  app.use(requestId);
  registerProjectAuthRoutes(app, () => toNodeHandler(auth), (_req, _res, next) => next());
  app.use(express.json());
  app.use(scopePerRequest(createContainer().register({
    StorageService: asValue(service), BucketService: asValue(buckets), UserAdminService: asValue(new UserAdminService({ prisma } as any)),
  })));
  app.use(controller([AuthAdminController, StorageBucketController, FileController, StoragePublicController]));
  app.use(createApiErrorHandler({ isProduction: true }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = createProjectAuth({ prisma, secret: 'sdk-audit-secret'.padEnd(40, 'x'), baseURL: baseUrl,
    sendOtp: async () => {}, sendMagicLink: async () => {} });
  secret = createClient(baseUrl, key.clearToken);
  anon = createClient(baseUrl);
  user = createClient(baseUrl);
  const email = `${slug}@example.test`;
  emails.push(email);
  expect((await user.auth.signUp.email({ email, password: 'audit-password-1', name: email })).error).toBeNull();
  expect((await secret.storage.createBucket(slug)).error).toBeNull();
  bucketId = (await buckets.getBySlug(slug)).id;
}, 30_000);

beforeEach(() => { policies = false; });

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  restore?.();
  for (const policy of ['sdk_audit_insert', 'sdk_audit_select', 'sdk_audit_update', 'sdk_audit_delete']) {
    await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS ${policy} ON storage.files`);
  }
  if (bucketId) {
    await prisma.file.deleteMany({ where: { bucketId } });
    await prisma.bucket.delete({ where: { id: bucketId } });
  }
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  if (secretId) await prisma.projectApiKey.delete({ where: { id: secretId } });
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  await pool.end();
});

describe('SDK with real HTTP, Postgres RLS and local object bytes', () => {
  it('uploads, downloads, lists, copies, moves, overwrites and removes with only the secret key', async () => {
    const bucket = secret.storage.from(slug);
    const key = 'nested/100%25 #.bin';
    expect((await bucket.upload(key, Buffer.from([0, 1, 255]))).error).toBeNull();
    const downloaded = await bucket.download(key);
    expect(downloaded.error).toBeNull();
    expect([...new Uint8Array(await downloaded.data!.arrayBuffer())]).toEqual([0, 1, 255]);
    expect((await bucket.info(key)).error).toBeNull();
    expect((await bucket.exists(key)).data).toBe(true);
    expect((await bucket.list('nested/')).data?.map(file => file.name)).toContain(key);
    expect((await bucket.copy(key, 'copy.bin')).error).toBeNull();
    expect((await bucket.move('copy.bin', 'moved.bin')).error).toBeNull();
    expect((await bucket.update('moved.bin', Buffer.from('updated'))).error).toBeNull();
    expect(await (await bucket.download('moved.bin')).data!.text()).toBe('updated');
    expect((await bucket.remove([key, 'moved.bin'])).error).toBeNull();
  });

  it('lets service_role remove a session-owned object while an anonymous caller is refused', async () => {
    const upload = await user.storage.from(slug).upload('owned.txt', new Blob(['owned']));
    expect(upload.error).toBeNull();
    expect((await anon.storage.from(slug).remove(['owned.txt'])).error).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect((await secret.storage.from(slug).remove(['owned.txt'])).error).toBeNull();
  });

  it('allows INSERT-only anonymous multipart uploads without granting read or delete', async () => {
    policies = true;
    await prisma.$executeRawUnsafe(`CREATE POLICY sdk_audit_insert ON storage.files FOR INSERT TO anon
      WITH CHECK ("bucketId" = '${bucketId}' AND size <= 3 AND mime = 'text/plain')`);
    try {
      const bucket = anon.storage.from(slug);
      const uploaded = await bucket.upload('write-only.txt', Buffer.from('abc'), { contentType: 'text/plain' });
      expect(uploaded.error).toBeNull();
      expect((await bucket.download('write-only.txt')).error).toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect((await bucket.remove(['write-only.txt'])).error).toMatchObject({ status: 403 });
      expect((await bucket.upload('too-big.txt', Buffer.from('abcd'), { contentType: 'text/plain' })).error).toMatchObject({ status: 403 });
      expect(await prisma.file.count({ where: { bucketId, key: `${slug}/write-only.txt` } })).toBe(1);
    } finally {
      await prisma.$executeRawUnsafe('DROP POLICY sdk_audit_insert ON storage.files');
    }
  });

  it('does not infer DELETE or UPDATE permission from a SELECT policy, and applies RLS before pagination', async () => {
    policies = true;
    const bucket = secret.storage.from(slug);
    for (const key of ['page/a-hidden', 'page/b-visible', 'page/c-visible']) {
      expect((await bucket.upload(key, Buffer.from('x'))).error).toBeNull();
    }
    await prisma.$executeRawUnsafe(`CREATE POLICY sdk_audit_select ON storage.files FOR SELECT TO anon
      USING ("bucketId" = '${bucketId}' AND key LIKE '%visible')`);
    try {
      const visitor = anon.storage.from(slug);
      expect((await visitor.list('page/', { limit: 1, offset: 1 })).data?.map(file => file.name)).toEqual(['page/c-visible']);
      expect((await visitor.remove(['page/b-visible'])).error).toMatchObject({ status: 403 });
      expect((await visitor.update('page/b-visible', Buffer.from('changed'))).error).toMatchObject({ status: 403 });
      await prisma.$executeRawUnsafe(`CREATE POLICY sdk_audit_update ON storage.files FOR UPDATE TO anon
        USING ("bucketId" = '${bucketId}') WITH CHECK (size <= 2)`);
      expect((await visitor.update('page/b-visible', Buffer.from('ok'))).error).toBeNull();
      expect((await visitor.update('page/b-visible', Buffer.from('too big'))).error).toMatchObject({ status: 403 });
      expect(await (await bucket.download('page/b-visible')).data!.text()).toBe('ok');
    } finally {
      await prisma.$executeRawUnsafe('DROP POLICY sdk_audit_select ON storage.files');
      await prisma.$executeRawUnsafe('DROP POLICY IF EXISTS sdk_audit_update ON storage.files');
    }
  });

  it('serves the shared public URL for nested keys containing literal percent signs', async () => {
    expect((await secret.storage.updateBucket(slug, { public: true })).error).toBeNull();
    const bucket = secret.storage.from(slug);
    const key = 'public/100%25.txt';
    expect((await bucket.upload(key, Buffer.from('public'))).error).toBeNull();
    const response = await fetch(bucket.getPublicUrl(key).data.publicUrl);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('public');
    expect((await secret.storage.updateBucket(slug, { public: false })).error).toBeNull();
  });

  it('performs auth.admin CRUD through the production route order', async () => {
    const email = `${slug}-admin-created@example.test`;
    emails.push(email);
    const created = await secret.auth.admin.createUser({ email, password: 'audit-password-1' });
    expect(created.error).toBeNull();
    const id = created.data!.user.id;
    expect((await secret.auth.admin.listUsers()).data?.users.some(row => row.id === id)).toBe(true);
    expect((await secret.auth.admin.getUserById(id)).error).toBeNull();
    expect((await secret.auth.admin.updateUserById(id, { firstName: 'Updated' })).error).toBeNull();
    expect((await secret.auth.admin.deleteUser(id)).error).toBeNull();
    expect(await prisma.user.findUnique({ where: { id } })).toBeNull();
  });

  it('finalizes a signed upload with its scoped token, without granting private read access', async () => {
    const driver = (service as any).driver as LocalStorageDriver;
    const presign = vi.spyOn(driver, 'getSignedUploadUrl').mockResolvedValue('https://storage.test/put');
    try {
      const signed = await secret.storage.from(slug).createSignedUploadUrl('signed.txt', { size: 3, contentType: 'text/plain' });
      expect(signed.error).toBeNull();
      const token = JSON.parse(signed.data!.token);
      const file = await prisma.file.findUniqueOrThrow({ where: { id: token.id } });
      await driver.put({ bucket: file.bucket, key: file.key, contentLength: 3,
        visibility: file.visibility, contentType: 'text/plain', body: Readable.from('abc') });
      const finalize = (value?: string) => fetch(`${baseUrl}/api/files/${file.id}/finalize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: value }),
      });
      expect((await finalize()).status).toBe(403);
      expect((await finalize(`${token.finalizeToken}bad`)).status).toBe(403);
      const response = await finalize(token.finalizeToken);
      expect(response.status).toBe(200);
      expect((await response.json()).data.url).toBeNull();
      expect(await (await secret.storage.from(slug).download('signed.txt')).data!.text()).toBe('abc');
      expect((await finalize(token.finalizeToken)).status).toBe(200);
    } finally {
      presign.mockRestore();
    }
  });

  it('signs in and self-deletes from Node, with the account and session removed', async () => {
    const email = `${slug}-self-delete@example.test`;
    emails.push(email);
    const client = createClient(baseUrl);
    expect((await client.auth.signUp.email({ email, password: 'audit-password-1', name: email })).error).toBeNull();
    expect((await client.auth.signIn.email({ email, password: 'audit-password-1' })).error).toBeNull();
    expect((await client.auth.deleteUser({ password: 'audit-password-1' })).error).toBeNull();
    expect(await client.hydrate()).toBeNull();
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });
});
