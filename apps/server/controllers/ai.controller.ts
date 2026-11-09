import { before, DELETE, GET, PATCH, POST, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import IContextContainer from '../context/icontext-container';
import { adminOnly } from '../middlewares/platform-admin.middleware';
import * as apiResponse from '../helpers/api-response.helper';
import { HttpException } from '../exceptions/http-exception';
import { env } from '../config/env';
import { PROVIDERS, providerSummaries, type ProviderId, type ThreadWithMessages } from '@motherbase/ai';


@route('/api/admin/ai')
export default class AiController {
  constructor(private di: IContextContainer) {}

  @GET()
  @route('/providers')
  @before(adminOnly)
  async providers(_req: Request, res: Response) {
    return apiResponse.successResponseWithData(res, 'OK', providerSummaries());
  }

  /**
   * The provider's live model catalogue for a given configuration, so neither
   * the settings form nor the dock makes the operator type a model id from
   * memory. Falls back to the descriptor's suggestions, never 500s on a
   * provider that is down.
   *
   * POST, not GET, because the settings form sends the key the operator has
   * just pasted but not saved: it must not travel in a query string, where
   * proxies and access logs would keep a copy of it.
   */
  @POST()
  @route('/models')
  @before(adminOnly)
  async models(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(
        res,
        'OK',
        await this.di.AiConfigService.catalogue(aiOverride(req.body)),
      );
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/test')
  @before(adminOnly)
  async test(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(
        res,
        'OK',
        await this.di.AiConfigService.test(aiOverride(req.body)),
      );
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/threads')
  @before(adminOnly)
  async listThreads(req: Request, res: Response, next: NextFunction) {
    try {
      const threads = await this.di.aiThreadStore.listThreads(this.scope(req));
      return apiResponse.successResponseWithData(res, 'OK', threads);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/threads/:id')
  @before(adminOnly)
  async getThread(req: Request, res: Response, next: NextFunction) {
    try {
      const thread = await this.ownedThread(req);
      return apiResponse.successResponseWithData(res, 'OK', thread);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/threads/:id')
  @before(adminOnly)
  async rename(req: Request, res: Response, next: NextFunction) {
    try {
      // ThreadStore.renameThread takes a bare id with no ownership check of
      // its own, so the controller must confirm the caller owns this thread
      // before renaming it: otherwise any signed-in user could rename (or, in
      // the sibling routes, read/delete) another user's conversation just by
      // guessing its id.
      await this.ownedThread(req);
      await this.di.aiThreadStore.renameThread(req.params.id, String(req.body?.title ?? ''));
      return apiResponse.successResponse(res, 'Renamed');
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/threads/:id')
  @before(adminOnly)
  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      await this.ownedThread(req);
      await this.di.aiThreadStore.deleteThread(req.params.id);
      return apiResponse.successResponse(res, 'Deleted');
    } catch (error: unknown) {
      return next(error);
    }
  }

  // Server-sent events. The browser cannot POST through EventSource, so Studio
  // reads this with fetch + a ReadableStream reader.
  @POST()
  @route('/chat')
  @before(adminOnly)
  async chat(req: Request, res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const scope = this.scope(req);

    try {
      for await (const event of this.di.AiChatService.chat({
        threadId: req.body?.threadId,
        message: String(req.body?.message ?? ''),
        // Per-message model switch from the dock. Bounded here rather than
        // trusted: it is a body field, and it ends up in a provider request.
        model: String(req.body?.model ?? '').trim().slice(0, 200) || undefined,
        context: req.body?.context ?? { project: scope.project, route: '/' },
        userId: scope.userId,
        project: scope.project,
        authHeaders: callerAuthHeaders(req.headers),
        adminBaseUrl: this.adminBaseUrl(req),
        signal: controller.signal,
      })) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      // Only the caught error's message ever reaches the stream. The chat
      // service never yields or throws the resolved AI config (which carries
      // the operator's decrypted API key), so nothing secret can appear here.
      res.write(`data: ${JSON.stringify({ type: 'error', message: (err as Error).message })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done', stopReason: 'error' })}\n\n`);
    } finally {
      res.end();
    }
  }

  /**
   * Approve or reject the write(s) the assistant proposed on this thread.
   * Same SSE shape as /chat, since it resumes the same provider loop. The
   * dock listens to both with one reader.
   */
  @POST()
  @route('/threads/:id/resolve')
  @before(adminOnly)
  async resolve(req: Request, res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const scope = this.scope(req);
    const decisions = req.body?.decisions;

    try {
      if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) {
        throw new HttpException('decisions must be a map of callId to true/false', 400);
      }
      for await (const event of this.di.AiChatService.resolve({
        threadId: req.params.id,
        decisions: Object.fromEntries(
          Object.entries(decisions as Record<string, unknown>).map(([id, v]) => [id, Boolean(v)]),
        ),
        model: String(req.body?.model ?? '').trim().slice(0, 200) || undefined,
        context: req.body?.context ?? { project: scope.project, route: '/' },
        userId: scope.userId,
        project: scope.project,
        authHeaders: callerAuthHeaders(req.headers),
        adminBaseUrl: this.adminBaseUrl(req),
        signal: controller.signal,
      })) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: (err as Error).message })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done', stopReason: 'error' })}\n\n`);
    } finally {
      res.end();
    }
  }

  /** Loads the thread for `req.params.id` and throws 404 unless it belongs to
   *  the caller's scope. Every route that takes a bare thread id must go
   *  through this before touching the store. */
  private async ownedThread(req: Request): Promise<ThreadWithMessages> {
    const thread = await this.di.aiThreadStore.getThread(req.params.id);
    const { project, userId } = this.scope(req);
    if (!thread || thread.project !== project || thread.userId !== userId) {
      throw new HttpException('Conversation not found', 404);
    }
    return thread;
  }

  private scope(req: Request) {
    const user = req.user as { id?: string; email?: string } | undefined;
    return {
      // There is no multi-project PROJECT_ID env var: in the console proxy the
      // project id arrives as a route param, and a standalone per-project
      // deployment has exactly one project, hence the 'default' literal.
      project: String(req.params.project ?? 'default'),
      userId: String(user?.id ?? user?.email ?? 'admin'),
    };
  }

  /**
   * Tools call this server's own admin API, so the agent goes through the same
   * controllers, guards and audit trail as the Studio user does.
   *
   * Loopback, deliberately, rather than the request's own Host. Behind the
   * Console the request arrives through `http-proxy` with the Host header
   * preserved, so `req.headers.host` is the **Console's** host. And
   * `https://console/api/admin/schema/tables` does not exist there (the Console
   * mounts the project surface at `/api/projects/:id/admin/*`). Every tool call
   * came back 404, which read as "the assistant has no tools".
   *
   * The loopback address is the one thing that is true in both deployments: the
   * process listens on PORT, plain HTTP, whatever fronts it.
   */
  private adminBaseUrl(_req: Request): string {
    const host = env.BIND_HOST === '0.0.0.0' || !env.BIND_HOST ? '127.0.0.1' : env.BIND_HOST;
    return `http://${host}:${env.PORT}/api/admin`;
  }
}

/**
 * The unsaved settings-form values a /models or /test call may carry.
 *
 * Every field is bounded and the provider is checked against the registry, so a
 * body field can never widen what reaches a provider SDK. Absent fields are left
 * undefined rather than blanked, which is how AiConfigService tells "the
 * operator cleared this" from "the form did not send it".
 */
export function aiOverride(body: unknown): {
  provider?: ProviderId;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
} {
  const input = (body ?? {}) as Record<string, unknown>;
  const text = (value: unknown, max: number) =>
    typeof value === 'string' ? value.trim().slice(0, max) : undefined;
  const provider = text(input.provider, 40);
  return {
    provider: PROVIDERS.some(p => p.id === provider) ? (provider as ProviderId) : undefined,
    model: text(input.model, 200),
    apiKey: text(input.apiKey, 500),
    baseUrl: text(input.baseUrl, 500),
  };
}

/**
 * The credential a request arrived with, to be forwarded to the agent's tools
 * verbatim.
 *
 * Two shapes, and reading only the first is the bug this replaces: a standalone
 * deployment sends the user's `Authorization: Bearer`, while the Console proxy
 * **deletes** Authorization and substitutes `X-Platform-Token` (see
 * `applyAdminProxyHeaders`). Taking Authorization alone therefore sent
 * `Bearer ` (an empty credential) on every tool call made through the Console.
 *
 * Never substitutes a service or admin token, and never falls back to one: with
 * neither header present the tool calls fail with 401s, which is the correct,
 * safe outcome.
 */
export function callerAuthHeaders(headers: {
  authorization?: string;
  'x-platform-token'?: string | string[];
}): Record<string, string> {
  const platformToken = headers['x-platform-token'];
  if (typeof platformToken === 'string' && platformToken) {
    return { 'X-Platform-Token': platformToken };
  }
  const authorization = String(headers.authorization ?? '');
  return authorization ? { Authorization: authorization } : {};
}
