import { timingSafeEqual } from 'crypto';
import { errorMessage } from '../../lib/errors';
import express, { type NextFunction, type Request, type Response } from 'express';
import '../../lib/express-async-errors';
import { assertProjectSlug, isOrchestrationAction } from './contracts';
import type { OrchestrationRuntimeApi } from './runtime';

interface AuditRecord {
  at: string;
  event: string;
  project?: string;
  action?: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

type AuditFn = (record: AuditRecord) => void;

const MAX_FAILURE_DETAIL = 2_000;

/**
 * What went wrong, for the Console's logs: the tail of the failed command's
 * stderr (where Compose explains itself), else the error message. Without it
 * every failure reached the operator as the same opaque sentence.
 */
function failureDetail(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const detail = typeof stderr === 'string' && stderr.trim() ? stderr.trim() : errorMessage(error);
  return detail.slice(-MAX_FAILURE_DETAIL);
}

function bearerMatches(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createOrchestrationApp(
  runtime: OrchestrationRuntimeApi,
  secret: string,
  audit: AuditFn = record => console.log(JSON.stringify({ component: 'orchestration-daemon', ...record })),
) {
  if (secret.length < 32) throw new Error('ORCHESTRATION_SECRET must be at least 32 characters');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1kb' }));
  app.get('/health', async (_req, res) => {
    try {
      await runtime.health();
      return res.json({ ok: true });
    } catch {
      return res.status(503).json({ ok: false });
    }
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!bearerMatches(req.headers.authorization, secret)) {
      audit({ at: new Date().toISOString(), event: 'auth', ok: false, durationMs: 0 });
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  });

  const handle = <T>(event: string, operation: (req: Request) => Promise<T>) =>
    async (req: Request, res: Response) => {
      const started = Date.now();
      const project = req.params.project;
      const action = req.params.action;
      try {
        const data = await operation(req);
        audit({ at: new Date().toISOString(), event, project, action, ok: true, durationMs: Date.now() - started });
        return res.json({ data });
      } catch (error: unknown) {
        const message = errorMessage(error);
        audit({ at: new Date().toISOString(), event, project, action, ok: false, durationMs: Date.now() - started, error: message });
        const invalid = message.startsWith('invalid project slug') || message === 'invalid orchestration action';
        return res.status(invalid ? 400 : 500).json({
          error: invalid ? message : `Orchestration operation failed: ${failureDetail(error)}`,
        });
      }
    };

  app.get('/v1/projects/running', handle('projects.running', () => runtime.runningNames()));
  app.get('/v1/metrics/containers', handle('metrics.containers', () => runtime.containerStats()));
  app.get('/v1/metrics/volumes', handle('metrics.volumes', () => runtime.volumeUsage()));
  app.get('/v1/projects/:project/container', handle('project.container', req =>
    runtime.container(assertProjectSlug(req.params.project))));
  app.get('/v1/projects/:project/logs', handle('project.logs', req =>
    runtime.logs(assertProjectSlug(req.params.project))));
  app.post('/v1/projects/:project/actions/:action', handle('project.action', req => {
    const project = assertProjectSlug(req.params.project);
    if (!isOrchestrationAction(req.params.action)) throw new Error('invalid orchestration action');
    return runtime.action(project, req.params.action);
  }));

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}
