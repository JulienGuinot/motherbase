import { before, DELETE, GET, PATCH, POST, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import IContextContainer from '../../context/icontext-container';
import { adminOnly } from '../../middlewares/platform-admin.middleware';
import * as apiResponse from '../../helpers/api-response.helper';
import { parseBody } from '../../lib/zod-body';

// 64 KiB is far past any key or certificate, and short of making a Vault row a
// file store.
const secretValue = z.string().min(1).max(65_536);
const secretName = z.string().trim().min(1).max(255);

const createSecretSchema = z.object({
  name: secretName,
  secret: secretValue,
  description: z.string().max(1000).default(''),
});

const updateSecretSchema = z
  .object({ name: secretName.optional(), secret: secretValue.optional(), description: z.string().max(1000).optional() })
  .refine(patch => Object.values(patch).some(value => value !== undefined), 'nothing to update');

const secretIdSchema = z.string().uuid();

/**
 * Supabase Vault. Every route here is `secrets.manage` in the Console (see
 * adminProxyCapability), reads included: the list names what is stored, and
 * `reveal` returns plaintext.
 */
@route('/api/admin')
export default class AdminVaultController {
  constructor(private di: IContextContainer) {}

  @GET()
  @route('/vault')
  @before(adminOnly)
  async listSecrets(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.VaultService.list());
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/vault/enable')
  @before(adminOnly)
  async enableVault(_req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.VaultService.enable();
      return apiResponse.successResponseWithData(res, 'Enabled', await this.di.VaultService.status());
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/vault/secrets')
  @before(adminOnly)
  async createSecret(req: Request, res: Response, next: NextFunction) {
    try {
      const secret = await this.di.VaultService.create(parseBody(createSecretSchema, req.body));
      return apiResponse.successResponseWithData(res, 'Created', { secret });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/vault/secrets/:id/reveal')
  @before(adminOnly)
  async revealSecret(req: Request, res: Response, next: NextFunction) {
    try {
      const secret = await this.di.VaultService.reveal(parseBody(secretIdSchema, req.params.id));
      // A decrypted value must not be kept by a browser or proxy cache.
      res.setHeader('Cache-Control', 'no-store');
      return apiResponse.successResponseWithData(res, 'OK', { secret });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/vault/secrets/:id')
  @before(adminOnly)
  async updateSecret(req: Request, res: Response, next: NextFunction) {
    try {
      const secret = await this.di.VaultService.update(
        parseBody(secretIdSchema, req.params.id),
        parseBody(updateSecretSchema, req.body),
      );
      return apiResponse.successResponseWithData(res, 'Updated', { secret });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/vault/secrets/:id')
  @before(adminOnly)
  async deleteSecret(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.VaultService.remove(parseBody(secretIdSchema, req.params.id));
      return apiResponse.successResponse(res, 'Deleted');
    } catch (error: unknown) {
      return next(error);
    }
  }
}
