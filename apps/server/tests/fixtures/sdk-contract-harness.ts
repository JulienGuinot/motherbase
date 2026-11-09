import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import express, { type RequestHandler } from 'express';
import { asValue, createContainer } from 'awilix';
import { controller, scopePerRequest } from 'awilix-express';
import { HTTP_ROUTES } from '@motherbase/contracts';
import container from '../../container';
import prisma from '../../lib/prisma';
import { randomUUID } from 'node:crypto';
import FileController from '../../controllers/file.controller';
import { normalizeObjectKey } from '../../services/storage/storage.service';
import RestApiController from '../../controllers/rest-api.controller';
import EdgeInvokeController from '../../controllers/edge-invoke.controller';
import { registerProjectAuthRoutes } from '../../auth/routes';
import { createApiErrorHandler } from '../../middlewares/api-error.middleware';
import { HttpException } from '../../exceptions/http-exception';

export const CONTRACT_USER = {
  id: 'u-contract',
  email: 'contract@example.test',
  role: 'USER',
  status: 'active',
};
export const CONTRACT_TOKEN = 'contract-session-token';

type ContractRow = { id: string; user_id: string; label: string };

interface SpyLike {
  mockRestore(): void;
}

export interface SdkContractHarness {
  baseUrl: string;
  close(): Promise<void>;
}

function bearerToken(headers: Headers): string | null {
  return headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
}

function authHandler(): RequestHandler {
  return async (req, res) => {
    if (req.path === HTTP_ROUTES.authSignIn && req.method === 'POST') {
      if (req.body?.email !== CONTRACT_USER.email) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }
      return res.json({ token: CONTRACT_TOKEN, user: CONTRACT_USER });
    }

    if (req.path === HTTP_ROUTES.authSession && req.method === 'GET') {
      if (req.headers.authorization !== `Bearer ${CONTRACT_TOKEN}`) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      return res.json({ session: { token: CONTRACT_TOKEN }, user: CONTRACT_USER });
    }

    return res.status(404).json({ message: 'Auth route not found' });
  };
}

function filteredRow(rows: Map<string, ContractRow>, query: Record<string, unknown>): ContractRow | undefined {
  const id = String(query.id ?? '').replace(/^eq\./, '');
  return rows.get(id);
}

async function uploadBytes(body: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function createSdkContractHarness(spyOn: typeof import('vitest').vi.spyOn): Promise<SdkContractHarness> {
  const rows = new Map<string, ContractRow>();
  // Keyed by `bucket/key`, which is how the real service stores objects. The
  // matrix's storage rows are produced against this double, so it has to model
  // path addressing rather than only ids.
  const files = new Map<string, { id: string; bytes: Buffer; bucket: string; key: string; created: Date }>();
  const byId = new Map<string, string>();
  const restored: SpyLike[] = [];

  const originalResolve = container.resolve.bind(container);
  restored.push(
    spyOn(container, 'resolve').mockImplementation(((name: string | symbol) => {
      if (name !== 'AuthManager') return originalResolve(name as never);
      return {
        current: async () => ({
          api: {
            getSession: async ({ headers }: { headers: Headers }) =>
              bearerToken(headers) === CONTRACT_TOKEN ? { user: CONTRACT_USER } : null,
          },
        }),
      };
    }) as never),
    spyOn(prisma.user, 'findUnique').mockImplementation((async ({ where }: { where: { id?: string } }) =>
      where.id === CONTRACT_USER.id ? CONTRACT_USER : null) as never)
  );

  const services = {
    StorageService: {
      upload: async ({
        ownerId,
        body,
        bucketSlug,
        objectKey,
        upsert,
      }: {
        ownerId: string;
        body: Readable;
        size: number;
        bucketSlug?: string;
        objectKey?: string;
        upsert?: boolean;
      }) => {
        const bucket = bucketSlug ?? 'default';
        const key = objectKey ? normalizeObjectKey(objectKey) : `${randomUUID()}.bin`;
        const full = `${bucket}/${key}`;
        const existing = files.get(full);
        if (existing && !upsert) throw new HttpException(`An object already exists at ${full}`, 409);
        if (existing) byId.delete(existing.id);

        const id = randomUUID();
        files.set(full, { id, bytes: await uploadBytes(body), bucket, key, created: new Date() });
        byId.set(id, full);
        return { file: { id, ownerId, bucket }, url: `/api/files/${id}/raw` };
      },

      streamFile: async (id: string, scope: { userId?: string }) => {
        const entry = files.get(byId.get(id) ?? '');
        if (!entry || scope.userId !== CONTRACT_USER.id) throw new HttpException('File not found', 404);
        return { body: Readable.from(entry.bytes), contentLength: entry.bytes.length, mime: 'application/octet-stream' };
      },
      streamFileByKey: async (bucket: string, key: string, scope: { userId?: string }) => {
        const entry = files.get(`${bucket}/${normalizeObjectKey(key)}`);
        if (!entry || scope.userId !== CONTRACT_USER.id) throw new HttpException('File not found', 404);
        return { body: Readable.from(entry.bytes), contentLength: entry.bytes.length, mime: 'application/octet-stream' };
      },

      getDownloadUrl: async (id: string) => {
        if (!byId.has(id)) throw new HttpException('File not found', 404);
        return { url: `/api/files/${id}/raw`, expiresAt: null };
      },
      getDownloadUrlByKey: async (bucket: string, key: string) => {
        const entry = files.get(`${bucket}/${normalizeObjectKey(key)}`);
        if (!entry) throw new HttpException('File not found', 404);
        return { url: `/api/files/${entry.id}/raw`, expiresAt: null };
      },

      remove: async (id: string, scope: { userId?: string }) => {
        const full = byId.get(id);
        if (!full || scope.userId !== CONTRACT_USER.id) throw new HttpException('File not found', 404);
        files.delete(full);
        byId.delete(id);
        return { deleted: true as const };
      },
      removeByKey: async (bucket: string, key: string, scope: { userId?: string }) => {
        const full = `${bucket}/${normalizeObjectKey(key)}`;
        const entry = files.get(full);
        if (!entry || scope.userId !== CONTRACT_USER.id) throw new HttpException('File not found', 404);
        files.delete(full);
        byId.delete(entry.id);
        return { deleted: true as const };
      },

      listObjects: async (bucket: string, options: { prefix?: string; limit?: number; offset?: number } = {}) => {
        const prefix = options.prefix ? `${bucket}/${normalizeObjectKey(options.prefix)}/` : `${bucket}/`;
        return [...files.values()]
          .filter(entry => `${entry.bucket}/${entry.key}`.startsWith(prefix))
          .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 100))
          .map(entry => ({
            name: entry.key,
            id: entry.id,
            created_at: entry.created.toISOString(),
            updated_at: entry.created.toISOString(),
            last_accessed_at: null,
            metadata: { size: entry.bytes.length, mimetype: 'application/octet-stream', cacheControl: null },
          }));
      },
    },
    RestApiService: {
      handleGet: async (_model: string, _query: Record<string, unknown>, user?: { id: string }) =>
        [...rows.values()].filter(row => row.user_id === user?.id),
      // The controller reads through `handleSelect` so it can set Content-Range
      // and honour Prefer: count. The double answers the same
      // rows plus the envelope the controller unwraps.
      handleSelect: async (_model: string, _query: Record<string, unknown>, user?: { id: string }) => {
        const visible = [...rows.values()].filter(row => row.user_id === user?.id);
        return {
          rows: visible,
          count: null,
          offset: 0,
          contentRange: visible.length ? `0-${visible.length - 1}/*` : '*/*',
        };
      },
      handlePost: async (_model: string, body: ContractRow, user?: { id: string }) => {
        if (body.user_id !== user?.id) throw new HttpException('blocked by policy', 403, 'FORBIDDEN');
        rows.set(body.id, body);
        return [body];
      },
      handlePatch: async (
        _model: string,
        query: Record<string, unknown>,
        body: Partial<ContractRow>,
        user?: { id: string }
      ) => {
        const row = filteredRow(rows, query);
        if (!row || row.user_id !== user?.id) throw new HttpException('Not found', 404, 'NOT_FOUND');
        const updated = { ...row, ...body };
        rows.set(row.id, updated);
        return [updated];
      },
      handleDelete: async (_model: string, query: Record<string, unknown>, user?: { id: string }) => {
        const row = filteredRow(rows, query);
        if (!row || row.user_id !== user?.id) throw new HttpException('Not found', 404, 'NOT_FOUND');
        rows.delete(row.id);
        return [row];
      },
    },
    EdgeFunctionService: {
      invokeRoute: async (route: string, body: Record<string, unknown>) => {
        if (route !== 'private-contract') throw new HttpException('Function not found', 404, 'NOT_FOUND');
        return { echoed: body.value };
      },
    },
  };

  const requestContainer = createContainer().register({
    StorageService: asValue(services.StorageService),
    RestApiService: asValue(services.RestApiService),
    EdgeFunctionService: asValue(services.EdgeFunctionService),
  });
  const app = express();
  app.use(express.json());
  registerProjectAuthRoutes(
    app,
    async () => authHandler(),
    (_req, _res, next) => next()
  );
  app.use(scopePerRequest(requestContainer));
  app.use(controller([FileController, RestApiController, EdgeInvokeController]));
  app.use(createApiErrorHandler({ isProduction: true }));

  let server: HttpServer;
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server!.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
      restored.reverse().forEach(spy => spy.mockRestore());
    },
  };
}
