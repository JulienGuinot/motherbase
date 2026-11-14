import type { NextFunction, Request, Response } from 'express';
import container from '../container';
import prisma from '../lib/prisma';
import type { RlsUser } from '../lib/rls-claims';
import type { ResolvedApiKey } from '../services/api-key.service';
import type { ThirdPartyCaller } from '../auth/third-party';
import { apiErrorEnvelope } from './api-error.middleware';

declare global {
  namespace Express {
    interface Request {
      /** Set by `apiKeyMiddleware` when the caller presented a valid project key. */
      apiKey?: ResolvedApiKey;
      /**
       * Set by `apiKeyMiddleware` when a SECRET key asked to run the request as
       * somebody else. `'anon'` means "as a signed-out visitor".
       *
       * Only ever written after the key type is verified. Nothing derived from a
       * user's own token or from a request body can set it.
       */
      impersonate?: RlsUser | 'anon';
      /** Set by the optional auth middleware for a verified third-party JWT (auth/third-party.ts). */
      thirdParty?: ThirdPartyCaller;
    }
  }
}

const KEY_PREFIX = 'mb_';

/**
 * Run this request as another user, or as nobody.
 *
 * The reason this exists: there is no other way to assert that a row level
 * security policy denies what it claims to deny. Testing a policy means issuing
 * the same query as three different callers, and doing that without this means
 * creating three real users and signing in as each, in a test, against a real
 * auth flow.
 *
 * It is gated on the secret key, which already bypasses RLS entirely, so this
 * can only ever LOWER the privilege of a caller who had everything. Presenting
 * it with anything less is refused rather than ignored: a test that silently
 * ran as service_role instead of as the user it named would pass while proving
 * nothing, which is worse than no test.
 */
const IMPERSONATE_HEADER = 'x-motherbase-impersonate';

function header(req: Request, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] ?? '' : String(value ?? '');
}

/**
 * Where a project key may be presented.
 *
 * `apikey` is the canonical header and the one the SDK sends. `Authorization:
 * Bearer` is accepted too, but only when the value carries the key prefix: that
 * header normally holds the end user's access token, and mistaking one for the
 * other in either direction would be a privilege bug.
 */
export function presentedToken(req: Request): string {
  const explicit = header(req, 'apikey').trim();
  if (explicit) return explicit;
  const authorization = header(req, 'authorization').trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim() ?? '';
  return bearer.startsWith(KEY_PREFIX) ? bearer : '';
}

/**
 * Resolves the project API key onto `req.apiKey`, and refuses the request when
 * the operator has turned `api.rest.requireApiKey` on and the key is missing or
 * invalid.
 *
 * This never *grants* data access on its own: a publishable key leaves the
 * caller exactly where they were (anon, or authenticated via their own bearer
 * token, RLS in force). Only a secret key changes the Postgres role, and only
 * because `RestApiService` reads `req.apiKey.type` when it builds the RLS
 * context. Enforcement off means the header is read and honoured when present,
 * which is what lets a secret key work before an operator locks the project.
 */
export async function apiKeyMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = presentedToken(req);
  try {
    const resolved = token ? await container.resolve('ApiKeyService').resolve(token) : null;
    if (resolved) req.apiKey = resolved;

    const cfg = await container
      .resolve('SettingsService')
      .get<{ requireApiKey?: boolean }>('api.keys')
      .catch(() => null);

    if (!resolved && (token || cfg?.requireApiKey)) {
      return res.status(401).json(apiErrorEnvelope('UNAUTHORIZED', token
          ? 'Invalid or revoked project API key.'
          : 'This project requires an API key. Send it in the apikey header.', req.id));
    }

    const impersonated = header(req, IMPERSONATE_HEADER).trim();
    if (impersonated) {
      if (resolved?.type !== 'secret') {
        return res.status(403).json(apiErrorEnvelope('FORBIDDEN',
          `${IMPERSONATE_HEADER} requires a secret project API key. The request was refused rather than run as the caller.`, req.id));
      }
      if (impersonated === 'anon') {
        req.impersonate = 'anon';
      } else {
        const user = await prisma.user.findUnique({
          where: { id: impersonated },
          select: { id: true, role: true, email: true, isAnonymous: true },
        });
        if (!user) {
          return res.status(400).json(apiErrorEnvelope('BAD_REQUEST',
            `${IMPERSONATE_HEADER}: no user with id '${impersonated}'. Pass a user id, or 'anon'.`, req.id));
        }
        req.impersonate = { id: user.id, role: user.role ?? undefined, email: user.email, isAnonymous: user.isAnonymous };
      }
    }

    return next();
  } catch (error: unknown) {
    return next(error);
  }
}

/**
 * Refuses anything that is not a valid secret key.
 *
 * This is the gate on `/api/auth/admin/*`, the surface that creates, edits and
 * deletes users without being any user. It is deliberately NOT the same gate as
 * the Studio admin API: that one runs SQL, DDL, backups and settings changes,
 * and a single credential that both bypasses RLS and drops tables is a far worse
 * thing to leak than either alone.
 *
 * Runs after `apiKeyMiddleware`, which is what populates `req.apiKey`. On its
 * own it grants nothing, so mounting it without that one fails closed.
 */
export function requireSecretKey(req: Request, res: Response, next: NextFunction) {
  if (req.apiKey?.type === 'secret') return next();
  return res.status(401).json(apiErrorEnvelope('UNAUTHORIZED',
    'This endpoint requires a secret project API key in the apikey header.', req.id));
}

/**
 * The caller the data plane should run as: the request user, plus the one flag
 * that can raise it to `service_role`. Every REST entry point passes this
 * rather than `req.user`, so the flag cannot be honoured on one route and
 * dropped on another.
 */
export function callerFor(req: Request): RlsUser | undefined {
  // Impersonation wins over everything, including the secret key that
  // authorised it: the point is to run WITHOUT service_role. `'anon'` is a
  // caller of nobody, which is what `undefined` means to `rlsContextFor`.
  if (req.impersonate) return req.impersonate === 'anon' ? undefined : req.impersonate;

  const serviceRole = req.apiKey?.type === 'secret';
  if (!req.user && !req.tokenUser && req.thirdParty) {
    const { sub, email, role, claims } = req.thirdParty;
    return { id: sub, email, external: { role, claims }, serviceRole };
  }
  // An access token already holds exactly the fields the data plane reads.
  if (!req.user && req.tokenUser) return { ...req.tokenUser, serviceRole };
  if (!req.user) return serviceRole ? { serviceRole: true } : undefined;
  // Projected field by field rather than spread: `req.user` is a row, and a row
  // that ever grew a column named `serviceRole` would otherwise hand every
  // authenticated caller BYPASSRLS. Only `req.apiKey` may decide this.
  return { id: req.user.id, role: req.user.role, email: req.user.email, isAnonymous: req.user.isAnonymous, serviceRole };
}
