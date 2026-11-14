// Inject env variables
import { config } from 'dotenv';
config();

import express, { Request, Response } from 'express';
import './lib/express-async-errors';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import logger from 'morgan';
import prisma from './lib/prisma';
import { fromNodeHeaders } from 'better-auth/node';
import { globalLimiter, authLimiter, applyRateLimitLimits } from './middlewares/rate-limit';
import {
  customRulesLimiter,
  applyRateLimitRules,
  setRateLimitIdentityResolver,
} from './middlewares/custom-rate-limit';
import { applyCaptchaConfig, captchaGuard } from './middlewares/captcha-guard';
import { requestLogger } from './middlewares/request-logger';
import { rejectScannerProbes } from './middlewares/scanner-probe';
import { presentedToken } from './middlewares/api-key.middleware';
import { requestId } from './middlewares/request-id.middleware';
import swaggerUi from 'swagger-ui-express';
import { openapiSpec } from './config/openapi';
import cookieParser from 'cookie-parser';
import { loadControllers, scopePerRequest } from 'awilix-express';
import { EDGE_MAIL_CALLBACK_PATH, handleEdgeMailCallback } from './services/admin/edge-sandbox';
import container from './container';
import bodyParser from 'body-parser';
import { registerStorageProtocolRoutes } from './lib/storage-protocol-routes';
import { userContentHeaders } from './helpers/storage-stream.helper';
import { createCorsOptionsDelegate, parseCorsOrigins, validateProdCorsConfig } from './middlewares/cors.middleware';
import { createBucketCorsLoader } from './middlewares/bucketCors.middleware';
import { env } from './config/env';
import { installProcessSafety } from './lib/process-safety';
import { errorMessage } from './lib/errors';
import { createApiErrorHandler } from './middlewares/api-error.middleware';
import { HttpException } from './exceptions/http-exception';
import { bigintReplacer } from './lib/json-bigint';
import { APP_NAME } from './constants/app.constants';
import { logBuffer } from './models';
import { logActivity } from './lib/activity-log';
import { INSTANCE_ID } from './lib/instance';
const { NODE_ENV } = process.env;

/** Loopback binds are unreachable from another host, whatever the firewall says. */
const isLoopback = (host: string): boolean =>
  host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.startsWith('127.');

// Production must run with an explicit CORS allowlist. Fail fast otherwise.
const corsConfigError = validateProdCorsConfig();
if (corsConfigError) {
  console.error(`❌ Refusing to boot: ${corsConfigError}`);
  process.exit(1);
}
const app = express();
const http = require('http').Server(app);

// res.json() runs every payload through this, so a Prisma BigInt column can
// never again 500 the route that returns it. See lib/json-bigint.
app.set('json replacer', bigintReplacer);

// Behind Traefik (see deploy/traefik) every request arrives from the proxy, so
// req.ip would be the proxy's address for all clients. Collapsing every caller
// into a single rate-limit bucket. TRUST_PROXY declares how many hops to trust;
// it stays opt-in because trusting X-Forwarded-For with no proxy in front lets
// clients spoof their own IP and bypass limits entirely.
if (env.TRUST_PROXY !== false) {
  app.set('trust proxy', env.TRUST_PROXY);
}

// socket connection
import { Server } from 'socket.io';
import { toNodeHandler } from 'better-auth/node';
import { HTTP_ROUTES } from '@motherbase/contracts';
import { registerProjectAuthRoutes } from './auth/routes';
import { readSession } from './auth/server-session';
import { createAuthRateLimiter } from './auth/rate-limits';
// Reuse the same CORS allowlist for Socket.IO instead of a blanket '*'.
const socketOrigins = parseCorsOrigins(env.CORS_ORIGINS);
const socketCorsOrigin =
  socketOrigins.length && !socketOrigins.includes('*')
    ? socketOrigins
    : NODE_ENV === 'production'
      ? false // no allowlist in prod → deny cross-origin sockets
      : true; // dev convenience
const io = new Server(http, {
  path: '/ws',
  cors: {
    origin: socketCorsOrigin,
  },
});

// Optional auth at the Socket.IO level (has access to handshake.auth).
// Anonymous connections are allowed: the token just enriches socket.data.
// Validates a Better Auth session (bearer token) rather than a raw app JWT.
io.use(async (socket, next) => {
  const token =
    (socket.handshake.auth as any)?.token ?? socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return next();
  try {
    const auth = await container.resolve('AuthManager').current();
    const session = await readSession(auth, new Headers({ authorization: `Bearer ${token}` }));
    if (session?.user) socket.data.user = { id: session.user.id, role: (session.user as any).role };
  } catch {
    /* invalid token → anonymous socket */
  }
  next();
});

container.resolve('SocketService').initialize(io);

const connectDB = async (): Promise<void> => {
  try {
    console.log('Attempting connection to PostgreSQL...');
    await prisma.$connect();

    if (NODE_ENV !== 'test') {
      console.log('Connected to PostgreSQL');
      console.log('App is running ... \n');
      console.log('Press CTRL + C to stop the process. \n');
    }
  } catch (err) {
    console.error('App DB Connection error:', errorMessage(err));
    process.exit(1);
  }
};

// Kick the connection off eagerly (so it overlaps the mounting below), but keep
// the promise: bootstrap() awaits it before listen(), so we never accept traffic
// on a process whose DB connection is still pending or already doomed.
const dbReady = connectDB();

// Load console-managed rate-limit overrides once the DB is reachable. Until this
// resolves the limiters use the env-seeded defaults, so a slow/unavailable DB
// never blocks limiting. Failures are non-fatal (keep env defaults).
container
  .resolve('SettingsService')
  .get('security.rateLimit')
  .then((limits: any) => applyRateLimitLimits(limits))
  .catch(() => {
    /* keep env-seeded defaults */
  });

// CAPTCHA on routes outside /api/auth (off until Attack Protection lists some).
container
  .resolve('SettingsService')
  .get('auth.attackProtection')
  .then((attack: any) => applyCaptchaConfig(attack))
  .catch(() => {
    /* no guarded routes until the DB is reachable */
  });

// Load operator-defined custom rate-limit rules (empty by default → no-op).
container
  .resolve('SettingsService')
  .get('security.rateLimitRules')
  .then((rules: any) => applyRateLimitRules(rules))
  .catch(() => {
    /* no custom rules until the DB is reachable */
  });

// How the custom rules engine resolves a caller's identity. Invoked ONLY when an
// enabled rule keys by / filters on user, role or API key, so purely IP/global
// rules add no per-request session lookup. Role/status are read live from the DB,
// never trusted from the token (mirrors auth/session.ts). Anonymous or malformed
// requests resolve to {} and fall back to IP bucketing.
setRateLimitIdentityResolver(async req => {
  const identity: { userId?: string; role?: string; apiKeyId?: string } = {};
  try {
    // Bucket by the id of a key that actually resolved, never by the raw header:
    // an unvalidated value lets a caller mint a fresh bucket per request. An
    // unknown key stays anonymous and falls back to IP bucketing.
    const key = await container.resolve('ApiKeyService').resolve(presentedToken(req));
    if (key) identity.apiKeyId = key.id;
    const auth = await container.resolve('AuthManager').current();
    const session = await readSession(auth, fromNodeHeaders(req.headers));
    const id = session?.user?.id;
    if (id) {
      const user = await prisma.user.findUnique({
        where: { id: String(id) },
        select: { id: true, role: true, status: true },
      });
      if (user && user.status === 'active') {
        identity.userId = user.id;
        identity.role = String(user.role);
      }
    }
  } catch {
    /* resolve as anonymous */
  }
  return identity;
});

// Bot probes (`/.env`, `/wp-login.php`, `POST /`) are turned away before any
// logging, so they never reach the Logs screen or its hot routes.
app.use(rejectScannerProbes);

// don't show the log when it is test
if (NODE_ENV !== 'test') {
  app.use(logger('dev'));
}

// Correlation id first, so every log line and every error envelope below can
// carry it. Echoed to the caller as `x-request-id`.
app.use(requestId);

// Capture one log line per request into the shared buffer (Studio Logs screen).
app.use(requestLogger);

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: {
    policy: "cross-origin"
  }
}));

// CORS: origin list is read from SettingsService on every request so it can be
// changed from the console without a server restart. Falls back to CORS_ORIGINS
// env var when the settings table is unreachable (e.g. during migrations).
app.use(
  cors(
    createCorsOptionsDelegate(() =>
      container.resolve('SettingsService').get<{ origins: string; credentials: boolean }>('server.cors'),
      undefined,
      createBucketCorsLoader(container.resolve('BucketService')),
    )
  )
);

// Global rate limiter
app.use(globalLimiter);

// Operator-defined custom rate-limit rules (most-restrictive-wins). No-op until
// rules exist; layered on top of the built-in scopes above.
app.use(customRulesLimiter);

// CAPTCHA on the routes Attack Protection lists, e.g. a table's REST API. After
// the limiters, so a flood of tokenless calls is throttled before it costs a
// round trip to the CAPTCHA provider.
app.use(captchaGuard);

// Better Auth owns /api/auth/* and reads the raw request body itself, so it MUST
// be mounted before any body parser below. The instance is resolved live from
// AuthManager so console auth-config changes apply without a restart.
// authLimiter (RATE_LIMIT_AUTH_MAX, default 20/window) gates credential
// endpoints. Without it these inherit only globalLimiter, ~1000 password
// guesses per window per IP.
// Supabase's per-kind auth limits (Auth · Rate limits), ahead of Better Auth.
app.use(HTTP_ROUTES.auth, createAuthRateLimiter(() => container.resolve('AuthManager').rateLimits()));

registerProjectAuthRoutes(
  app,
  async () => toNodeHandler(await container.resolve('AuthManager').current()),
  authLimiter,
  async () => (await (await container.resolve('AuthManager').current()).$context).authCookies.sessionToken.name,
  () => container.resolve('AuthManager').current(),
  async () => (await (await container.resolve('AuthManager').current()).$context).secret,
);

// TUS resumable uploads (and the S3 protocol) stream their own bodies, so they
// are mounted before any parser below can buffer or consume them.
registerStorageProtocolRoutes(app, {
  resumable: () => container.resolve('ResumableUploadService'),
  s3: () => container.resolve('S3ProtocolService'),
});

// Same `verify` as express.json below, for the same reason: a form-encoded
// webhook (Twilio signs the sorted form fields) needs the bytes as sent.
app.use(
  bodyParser.urlencoded({
    extended: true,
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(cookieParser());
app.use(express.raw());
// The CLI's migration workflow sends a whole local migrations directory in one
// body (`db diff`, `db reset`), which outgrows the 100kb default below on any
// real project. Parsed here first, the general parser then skips these bodies.
app.use('/api/admin/db', express.json({ limit: '25mb' }));
// `verify` keeps the exact bytes around on the request. Webhook signatures are
// HMACs over the raw body, and JSON.parse -> JSON.stringify is not byte-stable
// (key order, whitespace, unicode escapes), so re-serialising the parsed object
// produces a different digest and every delivery fails to verify. See
// git-repo.service.ts and the /api/git/webhook route.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

app.get('/docs/sdk.md', (_req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'docs', 'sdk.md'));
});

// Serve ONLY the public bucket statically. Private objects live in a sibling
// bucket under STATIC_PATH and are reachable only via the authenticated
// /api/files/:id/raw endpoint: never through a guessable static URL.
const staticRoot = env.STATIC_PATH;
const publicBucket = env.S3_PUBLIC_BUCKET;
app.use(
  `/${publicBucket}`,
  express.static(path.join(staticRoot, publicBucket), {
    setHeaders: res => {
      for (const [name, value] of Object.entries(userContentHeaders(String(res.getHeader('Content-Type') ?? '')))) {
        res.setHeader(name, value);
      }
    },
  }),
);
app.use(scopePerRequest(container));
container.resolve('initCron');

// Start the in-process automatic backup scheduler (no-op unless enabled in
// config). Skipped under test so unit runs don't spawn real cron timers.
if (NODE_ENV !== 'test') {
  container
    .resolve('BackupSchedulerService')
    .start()
    .catch((err: any) => logActivity('error', 'job', `[backup] scheduler start failed: ${err?.message ?? err}`));
  container
    .resolve('EdgeFunctionSchedulerService')
    .start()
    .catch((err: any) => logActivity('error', 'job', `[edge-function-scheduler] start failed: ${err?.message ?? err}`));
  container
    .resolve('StorageCleanupSchedulerService')
    .start()
    .catch((err: any) => logActivity('error', 'job', `[storage-cleanup] scheduler start failed: ${err?.message ?? err}`));
  container
    .resolve('BucketDeletionSchedulerService')
    .start()
    .catch((err: any) => logActivity('error', 'job', `[bucket-deletion] scheduler start failed: ${err?.message ?? err}`));

  container
    .resolve('DataRetentionSchedulerService')
    .start()
    .catch((err: any) => logActivity('error', 'job', `[data-retention] scheduler start failed: ${err?.message ?? err}`));

  // Copies the in-memory log buffer into platform.request_logs so the Logs
  // screen has history beyond the ring buffer and across restarts.
  container
    .resolve('LogPersistenceService')
    .start()
    .catch((err: any) => logActivity('error', 'job', `[log-persistence] start failed: ${err?.message ?? err}`));

  // Copies the same stream out to the project's log drains, if it has any.
  container
    .resolve('LogDrainService')
    .start()
    .catch((err: any) => logActivity('error', 'job', `[log-drains] start failed: ${err?.message ?? err}`));
}

app.use(loadControllers('controllers/**/*.ts', { cwd: __dirname }));
app.use(loadControllers('controllers/**/*.js', { cwd: __dirname }));

// The Deno edge sidecar posts a function's sendMail() here, authenticated by a
// token that lives only as long as the invocation (see edge-sandbox.ts).
app.post(EDGE_MAIL_CALLBACK_PATH, handleEdgeMailCallback);

// Route Prefixes
app.get('/api/health-check', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ message: 'Server is running!', status: 200, db: 'connected' });
  } catch {
    res.status(503).json({ message: 'Database unavailable', status: 503, db: 'disconnected' });
  }
});

// API documentation
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec as any));

// Service descriptor: names the two paths a prober actually wants. Deliberately
// no version: that is an infoleak with no caller who needs it.
app.get('/', (_req: Request, res: Response) =>
  res.json({
    name: `${APP_NAME} API`,
    docs: '/api/docs',
    health: '/api/health-check',
  }));

// Register the error handlers / 404 / listener. Kept in an async bootstrap so
// any future async mount step can run before the catch-all 404.
const bootstrap = async () => {
  // Route misses use the same envelope and policy as controller errors.
  app.all('*', (_req, _res, next) => next(new HttpException('Page not found', 404, 'NOT_FOUND')));

  // Keep this last so forwarded errors cannot bypass production masking.
  app.use(
    createApiErrorHandler({
      isProduction: env.IS_PRODUCTION,
      logger: entry => {
        const context = entry.method && entry.path ? `${entry.method} ${entry.path}` : 'HTTP request';
        // The id is the whole point of the line: it is what the caller was
        // handed in `x-request-id` and in the error body, and it is the only
        // way to find this trace from a report of an intermittent 500.
        const id = entry.requestId ? ` [${entry.requestId}]` : '';
        console.error(`[error]${id} ${context}:`, entry.internalMessage);
        logBuffer.push({
          level: 'error',
          source: 'http',
          // The path is what files the trace under the service that failed.
          path: entry.path,
          requestId: entry.requestId,
          message: `[error]${id} ${context}: ${entry.internalMessage}`,
        });
      },
    })
  );

  // Keep one un-awaited promise from taking the process down, and drain
  // in-flight requests on deploy/restart instead of severing them.
  installProcessSafety({
    // io.close() also closes the http server, but disconnects websockets first.
    // http.close() alone waits on them until the forced-exit timeout fires,
    // and the teardowns below never run.
    server: io,
    logs: logBuffer,
    closers: [
      // Anything still queued belongs in the table, not in the exiting heap.
      async () => {
        await container.resolve('LogPersistenceService').flush();
        container.resolve('LogPersistenceService').stop();
      },
      async () => container.resolve('BucketDeletionSchedulerService').stop(),
      async () => container.resolve('RealtimeOutboxSchedulerService').stop(),
      async () => container.resolve('BackupSchedulerService').stop(),
      async () => container.resolve('DataRetentionSchedulerService').stop(),
      async () => container.resolve('StorageCleanupSchedulerService').stop(),
      async () => container.resolve('LogDrainService').stop(),
      () => prisma.$disconnect(),
      () => container.resolve('RlsPool').end(),
    ],
  });

  // Don't advertise readiness before the DB is actually reachable.
  await dbReady;

  if (NODE_ENV !== 'test') {
    await container.resolve('RealtimeOutboxSchedulerService').start();
  }

  http.listen(env.PORT, env.BIND_HOST, () => {
    console.log(`Server is listening on ${env.BIND_HOST}:${env.PORT} (instance ${INSTANCE_ID})`);
    if (!env.IS_PRODUCTION && !isLoopback(env.BIND_HOST)) {
      // Outside production an unrecognised error answers with its stack trace.
      // That is intentional and useful, and it is exactly what must not be
      // reachable from a network, so widening the bind is worth saying out loud.
      console.warn(
        `⚠️  NODE_ENV=${NODE_ENV ?? 'development'} on a non-loopback interface (${env.BIND_HOST}). ` +
        'Error responses include stack traces in this mode. Use NODE_ENV=production for anything reachable by others.',
      );
    }
  });
};

bootstrap().catch(err => {
  // Without this the rejection is unhandled: node kills the process with no
  // usable line in `docker logs`, and the container crash-loops silently.
  console.error('❌ Boot failed:', errorMessage(err));
  process.exit(1);
});
