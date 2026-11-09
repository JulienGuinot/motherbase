import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { asValue, createContainer } from 'awilix';
import { controller, scopePerRequest } from 'awilix-express';
import { Readable } from 'node:stream';

const state = vi.hoisted(() => ({ policies: false }));
vi.mock('../container', () => ({ default: {
  resolve(name: string) {
    if (name === 'ApiKeyService') return { resolve: async (key: string) =>
      key === 'mb_secret_test' ? { type: 'secret' } : key === 'mb_publishable_test' ? { type: 'publishable' } : null };
    if (name === 'SettingsService') return { get: async () => ({ requireApiKey: false }) };
    if (name === 'StoragePolicyService') return { enabled: async () => state.policies };
    if (name === 'AuthManager') return { current: () => ({ api: { getSession: async ({ headers }: { headers: Headers }) =>
      headers.get('authorization') === 'Bearer session' ? { user: { id: 'user' } } : null } }) };
    throw new Error(`Unexpected service ${name}`);
  },
} }));
vi.mock('../lib/prisma', () => ({ default: { user: { findUnique: async () => ({ id: 'user', role: 'USER', status: 'active' }) } } }));

import FileController from '../controllers/file.controller';
import AuthAdminController from '../controllers/auth-admin.controller';
import { registerProjectAuthRoutes } from '../auth/routes';
import { createApiErrorHandler } from '../middlewares/api-error.middleware';

function harness() {
  const StorageService = {
    upload: vi.fn(async (..._args: any[]) => ({ file: { id: 'file' }, url: 'https://storage.test/file' })),
    presignUpload: vi.fn(async (..._args: any[]) => ({ file: { id: 'file' }, uploadUrl: 'https://storage.test/put' })),
    finalizeUpload: vi.fn(async (..._args: any[]) => ({ file: { id: 'file' } })),
    streamFileByKey: vi.fn(async (..._args: any[]) => ({ body: Readable.from('file'), contentLength: 4, mime: 'text/plain' })),
    streamFile: vi.fn(async (..._args: any[]) => ({ body: Readable.from('file'), contentLength: 4, mime: 'text/plain' })),
    getDownloadUrlByKey: vi.fn(async (..._args: any[]) => ({ url: 'https://storage.test/file', expiresAt: null })),
    getDownloadUrl: vi.fn(async (..._args: any[]) => ({ url: 'https://storage.test/file', expiresAt: null })),
    statObject: vi.fn(async (..._args: any[]) => ({ id: 'file' })),
    listObjects: vi.fn(async (..._args: any[]) => []),
    copyObject: vi.fn(async (..._args: any[]) => ({ path: 'copy' })),
    moveObject: vi.fn(async (..._args: any[]) => ({ path: 'move' })),
    removeByKey: vi.fn(async (..._args: any[]) => ({ deleted: true })),
    remove: vi.fn(async (..._args: any[]) => ({ deleted: true })),
  };
  const UserAdminService = {
    listPage: vi.fn(async (..._args: any[]) => ({ users: [], total: 0 })),
    create: vi.fn(async (body: unknown) => ({ user: body })),
    update: vi.fn(async (..._args: any[]) => ({ id: 'u1' })),
    setRole: vi.fn(async (..._args: any[]) => ({ id: 'u1' })),
  };
  const authHandler = vi.fn((_req, res) => res.status(404).json({ message: 'Better Auth' }));
  const app = express();
  app.use((req, _res, next) => { req.id = 'request-test'; next(); });
  registerProjectAuthRoutes(app, () => authHandler, (_req, _res, next) => next());
  app.use(express.json());
  app.use(scopePerRequest(createContainer().register({
    StorageService: asValue(StorageService), UserAdminService: asValue(UserAdminService),
  })));
  app.use(controller([AuthAdminController, FileController]));
  app.use(createApiErrorHandler({ isProduction: true }));
  return { app, StorageService, UserAdminService, authHandler };
}

beforeEach(() => { state.policies = false; });

describe('SDK data-plane routing and identity', () => {
  it.each(['apikey', 'Authorization'])('uploads with a secret key in %s and no user session', async header => {
    const { app, StorageService } = harness();
    const response = await request(app).post('/api/files/')
      .set(header, header === 'apikey' ? 'mb_secret_test' : 'Bearer mb_secret_test')
      .field('bucket', 'photos').field('path', 'x.png').attach('file', Buffer.from('file'), 'x.png');
    expect(response.status).toBe(200);
    expect(StorageService.upload).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: undefined, scope: { userId: undefined, caller: { serviceRole: true } },
    }));
  });

  it.each([
    ['get', '/object/photos/a.txt', 'streamFileByKey'],
    ['get', '/object-info/photos/a.txt', 'statObject'],
    ['get', '/object-url/photos/a.txt', 'getDownloadUrlByKey'],
    ['get', '/list/photos', 'listObjects'],
    ['get', '/file/raw', 'streamFile'],
    ['get', '/file/url', 'getDownloadUrl'],
    ['delete', '/object/photos/a.txt', 'removeByKey'],
    ['delete', '/file', 'remove'],
    ['post', '/copy', 'copyObject'],
    ['post', '/move', 'moveObject'],
    ['post', '/presign', 'presignUpload'],
    ['post', '/file/finalize', 'finalizeUpload'],
  ] as const)('accepts service_role on %s %s', async (method, path, service) => {
    const { app, StorageService } = harness();
    const response = await request(app)[method](`/api/files${path}`).set('apikey', 'mb_secret_test')
      .send({ bucket: 'photos', from: 'a', to: 'b', filename: 'a', size: 1 });
    expect(response.status).toBe(200);
    expect(StorageService[service]).toHaveBeenCalledOnce();
    expect(JSON.stringify(StorageService[service].mock.calls)).toContain('"serviceRole":true');
  });

  it('keeps session-based uploads working', async () => {
    const { app, StorageService } = harness();
    const response = await request(app).post('/api/files/').set('apikey', 'mb_publishable_test')
      .set('Authorization', 'Bearer session').attach('file', Buffer.from('x'), 'x.txt');
    expect(response.status).toBe(200);
    expect(StorageService.upload).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'user' }));
  });

  it('refuses an invalid key even when API-key enforcement is disabled', async () => {
    const { app } = harness();
    const response = await request(app).get('/api/files/list/photos').set('apikey', 'mb_secret_forged');
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ status: 0, code: 'UNAUTHORIZED', requestId: 'request-test' });
  });

  it('allows anonymous requests only in policy mode, without manufacturing an identity', async () => {
    const { app, StorageService } = harness();
    expect((await request(app).get('/api/files/list/photos')).status).toBe(401);
    state.policies = true;
    expect((await request(app).get('/api/files/list/photos')).status).toBe(200);
    expect(StorageService.listObjects.mock.calls[0]?.[2]).toEqual({ userId: undefined, caller: undefined });
  });

  it('does not regain session ownership when a secret key impersonates anon', async () => {
    state.policies = true;
    const { app, StorageService } = harness();
    await request(app).get('/api/files/list/photos').set('apikey', 'mb_secret_test')
      .set('Authorization', 'Bearer session').set('x-motherbase-impersonate', 'anon').expect(200);
    expect(StorageService.listObjects.mock.calls[0]?.[2]).toEqual({ userId: undefined, caller: undefined });
  });

  it('decodes percent-encoded object keys exactly once', async () => {
    const { app, StorageService } = harness();
    await request(app).get('/api/files/object-info/photos/folder/100%2525.png').set('apikey', 'mb_secret_test').expect(200);
    expect(StorageService.statObject).toHaveBeenCalledWith('photos', 'folder/100%25.png', expect.anything());
  });

  it('routes auth.admin past Better Auth, with JSON parsed and the secret-key guard enforced', async () => {
    const { app, authHandler, UserAdminService } = harness();
    await request(app).get('/api/auth/admin/users').set('apikey', 'mb_secret_test').expect(200);
    await request(app).get('/api/auth/admin/users').set('apikey', 'mb_publishable_test').expect(401);
    await request(app).post('/api/auth/admin/users').set('apikey', 'mb_secret_test').send({ email: 'test@example.test' }).expect(200);
    expect(UserAdminService.create).toHaveBeenCalledWith(expect.objectContaining({ email: 'test@example.test' }));
    expect(authHandler).not.toHaveBeenCalled();
    await request(app).get('/api/auth/get-session').expect(404);
    expect(authHandler).toHaveBeenCalledOnce();
  });

  it('refuses to mint or promote an ADMIN user with a secret key, and writes nothing', async () => {
    const { app, UserAdminService } = harness();
    const secret = 'mb_secret_test';
    await request(app).post('/api/auth/admin/users').set('apikey', secret).send({ email: 'a@example.test', role: 'ADMIN' }).expect(403);
    await request(app).post('/api/auth/admin/invite').set('apikey', secret).send({ email: 'a@example.test', role: 'ADMIN' }).expect(403);
    await request(app).patch('/api/auth/admin/users/u1').set('apikey', secret).send({ firstName: 'Ada', role: 'ADMIN' }).expect(403);
    expect(UserAdminService.create).not.toHaveBeenCalled();
    expect(UserAdminService.update).not.toHaveBeenCalled();
    expect(UserAdminService.setRole).not.toHaveBeenCalled();

    await request(app).post('/api/auth/admin/users').set('apikey', secret).send({ email: 'a@example.test', role: 'USER' }).expect(200);
    await request(app).patch('/api/auth/admin/users/u1').set('apikey', secret).send({ role: 'USER' }).expect(200);
    expect(UserAdminService.setRole).toHaveBeenCalledWith('u1', 'USER');
  });
});
