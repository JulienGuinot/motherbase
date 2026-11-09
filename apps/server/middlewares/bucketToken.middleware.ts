import { Request, Response, NextFunction } from 'express';
import type { Bucket, BucketToken } from '@prisma/client';
import IContextContainer from '../context/icontext-container';
import { HttpException } from '../exceptions/http-exception';

// Declared where they are set, like `apiKey` in api-key.middleware.ts. Without
// this, every reader of req.bucket casts through `any` and nothing checks that
// the controller and this guard still agree on the shape.
declare global {
  namespace Express {
    interface Request {
      /** The logical bucket named by `:slug`, set by `bucketTokenGuard`. */
      bucket?: Bucket;
      /** The verified token that authorized this request. */
      bucketToken?: BucketToken;
    }
  }
}

/**
 * Extracts the raw token from `Authorization: Bearer <token>` and verifies it
 * against the logical bucket identified by `:slug`. Attaches `req.bucket` and
 * `req.bucketToken` on success.
 */
export function bucketTokenGuard(requiredPermission: 'read' | 'write' | 'delete') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const di = req.container?.cradle as IContextContainer | undefined;
    if (!di) return next(new Error('DI container not available'));

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return next(new HttpException('Missing bearer token', 401, 'UNAUTHORIZED'));
    }
    const raw = authHeader.slice(7);
    const slug = req.params.slug;

    try {
      const token = await di.BucketService.verifyToken(raw, slug, requiredPermission);
      req.bucketToken = token;
      req.bucket = await di.BucketService.getBySlug(slug);
      next();
    } catch (error: unknown) {
      return next(error);
    }
  };
}
