import { GET, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import IContextContainer from '../context/icontext-container';

/**
 * The project's public signing keys at the path Supabase clients and JWT
 * libraries look for them (`<project>/auth/v1/.well-known/jwks.json`).
 *
 * Better Auth serves the same set at /api/auth/jwks; both read the one table
 * through the signing-key lifecycle, so they cannot disagree. Standby keys are
 * included on purpose: a verifier that caches this document already knows the
 * next key when it is rotated in.
 */
@route('/auth/v1/.well-known')
export default class JwksController {
  constructor(private di: IContextContainer) {}

  @GET()
  @route('/jwks.json')
  async jwks(_req: Request, res: Response, next: NextFunction) {
    try {
      // Short enough that a revocation propagates within minutes.
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.json(await this.di.SigningKeyService.jwks());
    } catch (error: unknown) {
      return next(error);
    }
  }
}
