import { normalizeObjectKey } from '../services/storage/storage.service';
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import express from 'express';
import { asValue, createContainer } from 'awilix';
import { controller, scopePerRequest } from 'awilix-express';
import { toNodeHandler } from 'better-auth/node';
import container from '../container';
import prisma from '../lib/prisma';
import { RlsPool } from '../lib/rls-pool';
import { RestApiService } from '../services/rest-api/rest-api.service';
import { SchemaService } from '../services/admin/schema.service';
import { createProjectAuth, type AuthInstance } from '../auth/instance';
import { registerProjectAuthRoutes } from '../auth/routes';
import FileController from '../controllers/file.controller';
import RestApiController from '../controllers/rest-api.controller';
import EdgeInvokeController from '../controllers/edge-invoke.controller';
import StorageBucketController from '../controllers/storage-bucket.controller';
import StorageRenderController from '../controllers/storage-render.controller';
import { ImageRenderService } from '../services/storage/image-render.service';
import { createApiErrorHandler } from '../middlewares/api-error.middleware';
import { HttpException } from '../exceptions/http-exception';
import { ApiKeyService } from '../services/api-key.service';
import AuthAdminController from '../controllers/auth-admin.controller';

/**
 * Live harness for the supabase-js compatibility matrix.
 *
 * Real: the Better Auth project instance (`createProjectAuth`), the REST
 * controller, `RestApiService`, `RlsPool` and Postgres. A request goes over real
 * HTTP through the production error middleware, exactly like
 * `sdk-server-contract.integration.test.ts` does.
 *
 * Doubled: `StorageService` and `EdgeFunctionService` are in-memory, following
 * `tests/fixtures/sdk-contract-harness.ts`. The storage and functions rows of the
 * matrix describe the client-side contract (which argument is a path, which
 * option is dropped), and those are decided in `packages/client/src`, not in the
 * driver behind them.
 *
 * Realtime is not served here: the client's realtime transport is socket.io, and
 * the established convention for exercising it is the `realtimeIoFactory` fake
 * socket from `realtime-channel.unit.test.ts`. The server side of realtime has
 * its own integration suites (`realtime-rls.integration.test.ts`).
 */

export const COMPAT_TABLE = 'sdk_compat_item';
/** Parent of COMPAT_TABLE. Exists so embedding has a real FK edge to resolve. */
const COMPAT_PARENT_TABLE = 'sdk_compat_owner';
/** A SECURITY INVOKER function, so `.rpc()` has something real to call. */
export const COMPAT_FUNCTION = 'sdk_compat_qty_over';

interface CompatFixtureRow {
  id: string;
  owner_id: string;
  label: string;
  qty: number;
  tag: string;
  /** Array column: the only shape cs / cd / ov actually apply to. */
  tags: string[];
  /** FK to COMPAT_PARENT_TABLE, nullable so embedding can be absent too. */
  owner_ref: string | null;
  /** jsonb column, so the json-path operand cases have something real to hit. */
  meta: Record<string, unknown>;
  note: string | null;
  is_done: boolean;
}

export interface SdkContractLiveHarness {
  baseUrl: string;
  publishableKey: string;
  /** Email/password of the seeded fixture user. */
  user: { id: string; email: string; password: string };
  /** Bearer token for the fixture user. */
  token: string;
  /** Latest OTP delivered by the auth instance, per email. */
  otps: Map<string, string>;
  /** Register an email for teardown so the suite leaves no rows behind. */
  trackEmail(email: string): string;
  close(): Promise<void>;
}

interface SpyLike {
  mockRestore(): void;
}

const COMPAT_ROWS: CompatFixtureRow[] = [
  { id: 'i1', owner_id: '', label: 'alpha', qty: 10, tag: 'a', tags: ['red', 'blue'], owner_ref: 'o1', meta: { kind: 'x', level: 1 }, note: 'first', is_done: true },
  { id: 'i2', owner_id: '', label: 'Beta', qty: 20, tag: 'b', tags: ['blue'], owner_ref: 'o1', meta: { kind: 'y', level: 2 }, note: null, is_done: false },
  { id: 'i3', owner_id: '', label: 'gamma', qty: 30, tag: 'a', tags: ['green'], owner_ref: null, meta: { kind: 'x', level: 3 }, note: 'third', is_done: false },
];

async function readAll(body: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function createSdkContractLiveHarness(
  spyOn: typeof import('vitest').vi.spyOn,
): Promise<SdkContractLiveHarness> {
  const otps = new Map<string, string>();
  // Keyed by `bucket/key`, as the real service stores objects. The matrix's
  // storage rows come from this double, so it models path addressing rather
  // than ids alone.
  const files = new Map<string, { id: string; bytes: Buffer; bucket: string; key: string; created: Date; mime?: string }>();
  const byId = new Map<string, string>();
  const emails: string[] = [];
  const restored: SpyLike[] = [];
  const pool = new RlsPool();

  // Declared ahead of its assignment because the handler closure below captures
  // it before `createProjectAuth` can run.
  // eslint-disable-next-line prefer-const
  let auth: AuthInstance;

  const storageService = {
    upload: async ({
      ownerId,
      body,
      mime,
      bucketSlug,
      objectKey,
      upsert,
    }: {
      ownerId: string;
      body: Readable;
      size: number;
      mime?: string;
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
      files.set(full, { id, bytes: await readAll(body), bucket, key, created: new Date(), mime });
      byId.set(id, full);
      return { file: { id, ownerId, bucket }, url: `/api/files/${id}/raw` };
    },

    streamFile: async (id: string) => {
      const entry = files.get(byId.get(id) ?? '');
      if (!entry) throw new HttpException('File not found', 404);
      return { body: Readable.from(entry.bytes), contentLength: entry.bytes.length, mime: 'application/octet-stream' };
    },
    streamFileByKey: async (bucket: string, key: string) => {
      const entry = files.get(`${bucket}/${normalizeObjectKey(key)}`);
      if (!entry) throw new HttpException('File not found', 404);
      return { body: Readable.from(entry.bytes), contentLength: entry.bytes.length, mime: entry.mime ?? 'application/octet-stream' };
    },

    remove: async (id: string) => {
      const full = byId.get(id);
      if (!full) throw new HttpException('File not found', 404);
      files.delete(full);
      byId.delete(id);
      return { deleted: true as const };
    },
    removeByKey: async (bucket: string, key: string) => {
      const full = `${bucket}/${normalizeObjectKey(key)}`;
      const entry = files.get(full);
      if (!entry) throw new HttpException('File not found', 404);
      files.delete(full);
      byId.delete(entry.id);
      return { deleted: true as const };
    },

    // statObject / copyObject / moveObject mirror the real StorageService: the
    // SDK's info(), exists(), copy() and move() route through them, and a
    // double that omits one answers 500 instead of exercising the surface.
    statObject: async (bucket: string, key: string) => {
      const entry = files.get(`${bucket}/${normalizeObjectKey(key)}`);
      if (!entry) throw new HttpException('File not found', 404);
      return {
        name: entry.key,
        id: entry.id,
        version: entry.created.toISOString(),
        bucket_id: bucket,
        updated_at: entry.created.toISOString(),
        created_at: entry.created.toISOString(),
        last_accessed_at: null,
        size: entry.bytes.length,
        content_type: 'application/octet-stream',
        cache_control: null,
        metadata: { size: entry.bytes.length, mimetype: 'application/octet-stream', cacheControl: null },
      };
    },

    copyObject: async (
      bucket: string,
      fromKey: string,
      toKey: string,
      _scope: unknown = {},
      options: { upsert?: boolean } = {},
    ) => {
      const from = `${bucket}/${normalizeObjectKey(fromKey)}`;
      const source = files.get(from);
      if (!source) throw new HttpException('File not found', 404);

      const destination = normalizeObjectKey(toKey);
      if (destination === normalizeObjectKey(fromKey)) {
        throw new HttpException('The source and destination keys are the same', 400);
      }
      const to = `${bucket}/${destination}`;
      const existing = files.get(to);
      if (existing && !options.upsert) throw new HttpException(`An object already exists at ${to}`, 409);
      if (existing) byId.delete(existing.id);

      const id = randomUUID();
      files.set(to, { id, bytes: source.bytes, bucket, key: destination, created: new Date() });
      byId.set(id, to);
      return { path: destination, id, fullPath: to };
    },

    moveObject: async (
      bucket: string,
      fromKey: string,
      toKey: string,
      scope: unknown = {},
      options: { upsert?: boolean } = {},
    ) => {
      const result = await storageService.copyObject(bucket, fromKey, toKey, scope, options);
      // Deleted only after the copy landed, as the real service does.
      await storageService.removeByKey(bucket, fromKey);
      return result;
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

    listObjects: async (bucket: string, options: { prefix?: string; limit?: number; offset?: number } = {}) => {
      const prefix = options.prefix ? `${bucket}/${normalizeObjectKey(options.prefix)}/` : `${bucket}/`;
      const offset = options.offset ?? 0;
      return [...files.values()]
        .filter(entry => `${entry.bucket}/${entry.key}`.startsWith(prefix))
        .slice(offset, offset + (options.limit ?? 100))
        .map(entry => ({
          name: entry.key,
          id: entry.id,
          created_at: entry.created.toISOString(),
          updated_at: entry.created.toISOString(),
          last_accessed_at: null,
          metadata: { size: entry.bytes.length, mimetype: 'application/octet-stream', cacheControl: null },
        }));
    },
  };

  const restApiService = new RestApiService({
    prisma,
    RlsPool: pool,
    SchemaService: new SchemaService({}),
    // Deliveries are covered by the realtime suites; here they must simply not
    // break the write transaction they run inside.
    RealtimeBroadcastService: {
      broadcast: async () => {},
      captureDeleteAudience: async () => ({ mode: 'disabled' as const }),
    },
    RealtimeOutboxService: { enqueue: async () => {} },
  } as never);

  const edgeFunctionService = {
    invokeRoute: async (route: string, body: Record<string, unknown>) => {
      if (route !== 'compat-echo') throw new HttpException('Function not found', 404, 'NOT_FOUND');
      return { echoed: body.value };
    },
  };

  const app = express();
  registerProjectAuthRoutes(
    app,
    () => toNodeHandler(auth),
    (_req, _res, next) => next(),
  );
  app.use(express.json());
  app.use(
    scopePerRequest(
      createContainer().register({
        StorageService: asValue(storageService),
        RestApiService: asValue(restApiService),
        EdgeFunctionService: asValue(edgeFunctionService),
        // The real render service over the storage double: the transform is
        // what the matrix case exercises, the bytes come from the double.
        ImageRenderService: asValue(new ImageRenderService({
          StorageService: storageService,
          SettingsService: { get: async () => ({}) },
        } as never)),
      }),
    ),
  );
  // StorageBucketController is mounted for its GATE, not its behaviour: the
  // bucket-admin case asserts that a session without a secret key is refused
  // with 401. Leaving it unmounted answered 404, which would have passed for
  // "not authorized" while proving only that the route was missing.
  app.use(controller([FileController, RestApiController, EdgeInvokeController, StorageBucketController, AuthAdminController, StorageRenderController]));
  app.use(createApiErrorHandler({ isProduction: true }));

  let server!: HttpServer;
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  auth = createProjectAuth({
    prisma,
    secret: 'sdk-contract-secret-'.padEnd(48, 'x'),
    baseURL: baseUrl,
    trustedOrigins: [baseUrl],
    sendOtp: async ({ email, otp }) => {
      otps.set(email, otp);
    },
    sendMagicLink: async () => {},
    methods: { emailPassword: true, magicLink: true, emailOTP: true },
    // A syntactically valid provider so `signInWithOAuth` can be exercised
    // without a network round trip: Better Auth builds the authorize URL locally.
    socialProviders: { google: { clientId: 'compat-client-id', clientSecret: 'compat-client-secret' } },
  });

  // The REST controller's optionalAuthMiddleware resolves the live auth instance
  // through AuthManager; point it at this harness's instance.
  const originalResolve = container.resolve.bind(container);
  restored.push(
    spyOn(container, 'resolve').mockImplementation(((name: string | symbol) => {
      if (name !== 'AuthManager') return originalResolve(name as never);
      return { current: async () => auth };
    }) as never),
  );

  const trackEmail = (email: string): string => {
    emails.push(email);
    return email;
  };

  // Fixture user + fixture table.
  const email = trackEmail(`sdk-compat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`);
  const password = 'compat-password-1';
  await auth.api.signUpEmail({ body: { email, password, name: email } });
  const signIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const token = signIn.headers.get('set-auth-token') ?? '';
  const dbUser = await prisma.user.findUnique({ where: { email } });
  const userId = dbUser!.id;

  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${COMPAT_TABLE} CASCADE`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${COMPAT_PARENT_TABLE} CASCADE`);
  await prisma.$executeRawUnsafe(
    `CREATE TABLE ${COMPAT_PARENT_TABLE} (id text PRIMARY KEY, name text NOT NULL)`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE TABLE ${COMPAT_TABLE} (
       id text PRIMARY KEY,
       owner_id text NOT NULL,
       label text NOT NULL,
       qty integer NOT NULL,
       tag text NOT NULL,
       tags text[] NOT NULL DEFAULT '{}',
       owner_ref text REFERENCES ${COMPAT_PARENT_TABLE}(id),
       meta jsonb NOT NULL DEFAULT '{}'::jsonb,
       note text,
       is_done boolean NOT NULL DEFAULT false
     )`,
  );
  await prisma.$executeRawUnsafe(`ALTER TABLE ${COMPAT_TABLE} ENABLE ROW LEVEL SECURITY`);
  await prisma.$executeRawUnsafe(`ALTER TABLE ${COMPAT_PARENT_TABLE} ENABLE ROW LEVEL SECURITY`);
  await prisma.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${COMPAT_TABLE} TO anon, authenticated`,
  );
  await prisma.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${COMPAT_PARENT_TABLE} TO anon, authenticated`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE POLICY compat_parent_all ON ${COMPAT_PARENT_TABLE} FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)`,
  );
  // SECURITY INVOKER (the default), so the body is subject to the caller's RLS.
  // The rpc case asserts against this; SECURITY DEFINER refusal has its own suite.
  await prisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION ${COMPAT_FUNCTION}(min_qty integer)
       RETURNS SETOF ${COMPAT_TABLE}
       LANGUAGE sql
       STABLE
     AS $fn$ SELECT * FROM ${COMPAT_TABLE} WHERE qty >= min_qty ORDER BY id $fn$`,
  );
  await prisma.$executeRawUnsafe(
    `GRANT EXECUTE ON FUNCTION ${COMPAT_FUNCTION}(integer) TO anon, authenticated`,
  );
  // Wide-open policies on purpose: these cases are about the PostgREST dialect,
  // not about RLS. RLS behaviour has its own suites.
  await prisma.$executeRawUnsafe(
    `CREATE POLICY compat_authenticated ON ${COMPAT_TABLE} FOR ALL TO authenticated USING (true) WITH CHECK (true)`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE POLICY compat_anon ON ${COMPAT_TABLE} FOR SELECT TO anon USING (true)`,
  );

  await prisma.$executeRawUnsafe(
    `INSERT INTO ${COMPAT_PARENT_TABLE} (id, name) VALUES ('o1', 'Owner one')`,
  );
  for (const row of COMPAT_ROWS) {
    row.owner_id = userId;
    await insertCompatRow(row);
  }

  const publishable = await new ApiKeyService({ prisma } as any).create('sdk-compat', 'publishable');
  return {
    baseUrl,
    publishableKey: publishable.clearToken,
    user: { id: userId, email, password },
    token,
    otps,
    trackEmail,
    close: async () => {
      await prisma.projectApiKey.delete({ where: { id: publishable.id } });
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${COMPAT_FUNCTION}(integer)`);
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${COMPAT_TABLE} CASCADE`);
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${COMPAT_PARENT_TABLE} CASCADE`);
      for (const tracked of emails) {
        const found = await prisma.user.findUnique({ where: { email: tracked } });
        if (!found) continue;
        await prisma.session.deleteMany({ where: { userId: found.id } });
        await prisma.account.deleteMany({ where: { userId: found.id } });
        await prisma.verification.deleteMany({ where: { identifier: tracked } });
        await prisma.user.delete({ where: { id: found.id } });
      }
      await new Promise<void>((done, fail) => server.close(error => (error ? fail(error) : done())));
      await pool.end();
      restored.reverse().forEach(spy => spy.mockRestore());
    },
  };
}

async function insertCompatRow(row: CompatFixtureRow): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${COMPAT_TABLE} (id, owner_id, label, qty, tag, tags, owner_ref, meta, note, is_done)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
    row.id,
    row.owner_id,
    row.label,
    row.qty,
    row.tag,
    row.tags,
    row.owner_ref,
    JSON.stringify(row.meta),
    row.note,
    row.is_done,
  );
}

/** Reset the fixture rows to their seeded state after a mutating case. */
export async function resetCompatRows(): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM ${COMPAT_TABLE}`);
  for (const row of COMPAT_ROWS) await insertCompatRow(row);
}
