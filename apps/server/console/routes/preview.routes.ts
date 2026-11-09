import { Router, Request, Response } from 'express';
import { verifyHubSignature } from '../../lib/webhook-signature';
import { errorMessage } from '../../lib/errors';
import { decide, expiredPreviews, previewComment, type PreviewConfig } from '../services/preview.service';

/**
 * GitHub webhook receiver for preview projects.
 *
 * Unlike every other console route this one is unauthenticated in the session
 * sense: GitHub has no account here. Its authentication is the HMAC signature
 * over the raw body, which is why the router needs the raw bytes and not the
 * parsed object: `JSON.stringify(req.body)` is not byte-identical to what was
 * signed, so verifying against it fails on any payload with unusual escaping and,
 * worse, succeeds on some that were altered.
 */

interface Deps {
  orchestrator: any;
  registry: any;
  logs?: { push: (entry: { level: 'info' | 'warn' | 'error'; source: string; message: string }) => void };
  config: PreviewConfig & { secret: string; githubToken: string; scheme: 'http' | 'https'; domainSuffix: string };
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}


export function previewRouter(deps: Deps): Router {
  const r = Router();
  const log = (level: 'info' | 'warn' | 'error', message: string) =>
    deps.logs?.push({ level, source: 'preview', message });

  const doFetch = deps.fetchImpl ?? fetch;

  async function comment(repo: string, pr: number, body: string): Promise<void> {
    if (!deps.config.githubToken) return;
    try {
      await doFetch(`https://api.github.com/repos/${repo}/issues/${pr}/comments`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${deps.config.githubToken}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ body }),
      });
    } catch (error: unknown) {
      // A comment is a courtesy. Failing to post one must never fail the
      // provisioning that already succeeded.
      log('warn', `could not comment on ${repo}#${pr}: ${errorMessage(error)}`);
    }
  }

  r.post(
    '/github',
    async (req: Request, res: Response) => {
      const raw: Buffer = (req as any).rawBody ?? Buffer.from('');
      const signature = String(req.headers['x-hub-signature-256'] ?? '');

      if (!verifyHubSignature(raw, signature, deps.config.secret)) {
        log('warn', 'rejected a webhook with an invalid signature');
        return res.status(401).json({ ok: false, message: 'invalid signature' });
      }

      const eventName = String(req.headers['x-github-event'] ?? '');
      if (eventName === 'ping') return res.json({ ok: true, pong: true });
      if (eventName !== 'pull_request') {
        return res.json({ ok: true, ignored: `event ${eventName || 'unknown'}` });
      }

      let payload: any;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return res.status(400).json({ ok: false, message: 'invalid JSON body' });
      }

      const decision = decide(payload, deps.config);
      if (decision.action === 'ignore') {
        return res.json({ ok: true, ignored: decision.reason });
      }

      // Answer GitHub immediately. Provisioning a stack takes minutes and the
      // webhook delivery times out long before that, which would make GitHub
      // retry and start a second one.
      res.json({ ok: true, action: decision.action, project: decision.project });

      void (async () => {
        try {
          if (decision.action === 'destroy') {
            log('info', `tearing down preview ${decision.project}`);
            await deps.orchestrator.destroy(decision.project);
            return;
          }

          const existing = await deps.registry.get(decision.project).catch(() => undefined);
          if (existing) {
            // The PR was pushed to again. Recreating would drop the database and
            // any state a reviewer had set up, so this only restarts it.
            log('info', `preview ${decision.project} exists, restarting`);
            await deps.orchestrator.restart(decision.project);
            return;
          }

          log('info', `provisioning preview ${decision.project} for ${decision.repo}#${decision.pr}`);
          await deps.orchestrator.create({ name: decision.project });

          const host = `${decision.project}.${deps.config.domainSuffix}`;
          const url = `${deps.config.scheme}://${host}`;
          await comment(decision.repo, decision.pr, previewComment(decision.project, url));
        } catch (error: unknown) {
          log('error', `preview ${decision.action} failed for ${decision.project}: ${errorMessage(error)}`);
        }
      })();

      return undefined;
    },
  );

  return r;
}

/**
 * Destroy preview stacks whose PR teardown never arrived. Exported so the
 * scheduler and a test can both drive it.
 */
export async function sweepPreviews(deps: {
  orchestrator: { destroy: (name: string) => Promise<unknown> };
  registry: { list: () => Promise<Array<{ name: string; createdAt?: string }>> };
  logs?: Deps['logs'];
  // Only the TTL policy, not the webhook credentials: sweeping needs no secret.
  config: PreviewConfig;
}): Promise<string[]> {
  const projects = await deps.registry.list().catch(() => []);
  const expired = expiredPreviews(projects, deps.config);
  for (const name of expired) {
    try {
      deps.logs?.push({ level: 'info', source: 'preview', message: `sweeping expired preview ${name}` });
      await deps.orchestrator.destroy(name);
    } catch (error: unknown) {
      deps.logs?.push({ level: 'error', source: 'preview', message: `sweep failed for ${name}: ${errorMessage(error)}` });
    }
  }
  return expired;
}
