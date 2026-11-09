import type { RequestHandler } from 'express';
import container from '../container';
import { HttpException } from '../exceptions/http-exception';
import { apiKeyMiddleware, callerFor } from './api-key.middleware';
import { optionalAuthMiddleware } from './auth.middleware';
import type { FileAccessScope } from '../services/storage/storage.service';

/** Derive identity from the effective caller, including secret-key impersonation. */
export function storageScopeFor(req: Parameters<RequestHandler>[0]): FileAccessScope {
  const caller = callerFor(req);
  return { userId: caller?.id, caller };
}

const requireStorageCaller: RequestHandler = async (req, _res, next) => {
  try {
    const caller = callerFor(req);
    if (caller?.serviceRole || caller?.id || await container.resolve('StoragePolicyService').enabled()) return next();
    return next(new HttpException('Storage requires a user session or a secret project API key. Anonymous access requires storage policies.', 401));
  } catch (error) {
    return next(error);
  }
};

// Same order as the REST routes: session, then project key.
export const storageIdentity = [optionalAuthMiddleware, apiKeyMiddleware];
export const storageAuth = [...storageIdentity, requireStorageCaller];
