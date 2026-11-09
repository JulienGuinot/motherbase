import { before, GET, POST, PATCH, PUT, DELETE, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import IContextContainer from '../../context/icontext-container';
import { adminOnly } from '../../middlewares/platform-admin.middleware';
import * as apiResponse from '../../helpers/api-response.helper';
import { HttpException } from '../../exceptions/http-exception';
import { removeUploadedFile, streamUpload, uploadedFileSource } from '../../helpers/multer.helper';
import { sendStorageObject } from '../../helpers/storage-stream.helper';
import { parseFileFilters } from '../../services/storage/file-query';
import type { FileAccessScope } from '../../services/storage/storage.service';
import { parseMimeList, parseSizeLimit } from '../../services/storage/upload-limits';
import { parseTransformOptions } from '../../services/storage/image-transform';
import { bucketCorsSchema } from '../../services/storage/bucket-cors';

const adminUpload = [...adminOnly, streamUpload.single('file')];

/** The admin API acts as the service role: no owner or policy check applies. */
const ADMIN_SCOPE: FileAccessScope = { caller: { serviceRole: true } };

const objectTransferSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  upsert: z.boolean().optional(),
});

function parseTransfer(body: unknown) {
  const parsed = objectTransferSchema.safeParse(body ?? {});
  if (!parsed.success) throw new HttpException('from and to are required object keys.', 400);
  return parsed.data;
}

/** The key after `/objects/`, which may itself contain slashes. */
const objectKeyOf = (req: Request): string => (req.params as Record<string, string>)[0] ?? '';

@route('/api/admin')
export default class AdminStorageController {
  constructor(private di: IContextContainer) {}

  @GET()
  @route('/storage/files')
  @before(adminOnly)
  async storageFiles(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await this.di.StorageService.listFiles(parseFileFilters(req.query));
      return apiResponse.successResponseWithData(res, 'OK', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/storage/files/:id/url')
  @before(adminOnly)
  async storageFileUrl(req: Request, res: Response, next: NextFunction) {
    try {
      const url = await this.di.StorageService.adminGetDownloadUrl(req.params.id);
      return apiResponse.successResponseWithData(res, 'OK', { url });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/storage/files/:id/raw')
  @before(adminOnly)
  async storageFileRaw(req: Request, res: Response, next: NextFunction) {
    try {
      const object = await this.di.StorageService.adminStreamFile(req.params.id);
      return await sendStorageObject(res, object);
    } catch (error: unknown) {
      return next(error);
    }
  }

  /** A resized copy, for the storage browser's thumbnails. Same query as /render/image. */
  @GET()
  @route('/storage/files/:id/render')
  @before(adminOnly)
  async storageFileRender(req: Request, res: Response, next: NextFunction) {
    try {
      const options = parseTransformOptions(req.query as Record<string, unknown>) ?? {};
      const image = await this.di.ImageRenderService.renderAdmin(req.params.id, options, req.headers.accept);
      return await sendStorageObject(res, image);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/storage/files')
  @before(adminUpload)
  async storageUpload(req: Request, res: Response, next: NextFunction) {
    try {
      const file = req.file;
      if (!file) throw new HttpException('file is required', 400);
      const source = uploadedFileSource(file);
      const visibility = req.body?.visibility === 'public' ? 'public' : 'private';
      const bucketSlug = req.body?.bucket?.trim() || undefined;
      // `path` addresses the object by key, as the public upload route does;
      // absent, the server generates one.
      const objectKey = typeof req.body?.path === 'string' && req.body.path.trim() ? req.body.path.trim() : undefined;
      const result = await this.di.StorageService.adminUpload({
        filename: file.originalname,
        body: source.body,
        size: source.size,
        mime: file.mimetype,
        visibility,
        bucketSlug,
        objectKey,
        upsert: req.body?.upsert === 'true',
      });
      return apiResponse.successResponseWithData(res, 'Uploaded', result);
    } catch (error: unknown) {
      return next(error);
    } finally {
      await removeUploadedFile(req.file);
    }
  }

  @DELETE()
  @route('/storage/files/:id')
  @before(adminOnly)
  async storageDelete(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.StorageService.adminRemove(req.params.id);
      return apiResponse.successResponse(res, 'Deleted');
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ── Bucket management ──────────────────────────────────────────────────────

  @GET()
  @route('/storage/buckets')
  @before(adminOnly)
  async listBuckets(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.BucketService.list());
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/storage/buckets')
  @before(adminOnly)
  async createBucket(req: Request, res: Response, next: NextFunction) {
    try {
      const { slug, name, description, visibility, quotaBytes, fileSizeLimit, allowedMimeTypes } = req.body;
      const bucket = await this.di.BucketService.create({
        slug,
        name,
        description,
        visibility,
        quotaBytes: quotaBytes != null ? BigInt(quotaBytes) : undefined,
        fileSizeLimit: parseSizeLimit(fileSizeLimit),
        allowedMimeTypes: parseMimeList(allowedMimeTypes),
      });
      return apiResponse.successResponseWithData(res, 'Created', bucket);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/storage/buckets/:slug')
  @before(adminOnly)
  async getBucket(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.BucketService.getBySlug(req.params.slug));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/storage/buckets/:slug')
  @before(adminOnly)
  async updateBucket(req: Request, res: Response, next: NextFunction) {
    try {
      const { name, description, visibility, quotaBytes, fileSizeLimit, allowedMimeTypes } = req.body;
      const patch: any = { name, description, visibility };
      if (quotaBytes !== undefined) patch.quotaBytes = quotaBytes === null ? null : BigInt(quotaBytes);
      if (fileSizeLimit !== undefined) patch.fileSizeLimit = parseSizeLimit(fileSizeLimit);
      if (allowedMimeTypes !== undefined) patch.allowedMimeTypes = parseMimeList(allowedMimeTypes);
      const bucket = await this.di.BucketService.update(req.params.slug, patch);
      return apiResponse.successResponseWithData(res, 'Updated', bucket);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/storage/buckets/:slug')
  @before(adminOnly)
  async deleteBucket(req: Request, res: Response, next: NextFunction) {
    try {
      const force = req.query.force === 'true';
      const result = await this.di.BucketService.delete(req.params.slug, force);
      return 'job' in result
        ? apiResponse.acceptedResponseWithData(res, 'Bucket deletion queued', result)
        : apiResponse.successResponseWithData(res, 'Deleted', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  // Unfinished deletions, so the storage screen can pick a running job back up
  // after a reload instead of losing track of it. Declared before the :id route
  // so "bucket-deletions" is not read as an id.
  @GET()
  @route('/storage/bucket-deletions')
  @before(adminOnly)
  async bucketDeletions(_req: Request, res: Response, next: NextFunction) {
    try {
      const jobs = await this.di.BucketDeletionService.listUnfinished();
      return apiResponse.successResponseWithData(res, 'OK', { jobs });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/storage/bucket-deletions/:id')
  @before(adminOnly)
  async bucketDeletionStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const job = await this.di.BucketDeletionService.get(req.params.id);
      return apiResponse.successResponseWithData(res, 'OK', job);
    } catch (error: unknown) {
      return next(error);
    }
  }
  @GET()
  @route('/storage/buckets/:slug/files')
  @before(adminOnly)
  async bucketFiles(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(
        res,
        'OK',
        await this.di.BucketService.listFiles(req.params.slug, parseFileFilters(req.query))
      );
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ── Objects by key ─────────────────────────────────────────────────────────
  //
  // The public `/api/files/object|list|copy|move` routes, for the admin API:
  // what `motherbase storage ls|cp|mv|rm` addresses as `ss:///bucket/key`.
  // Copy and move take both keys in the body, since each can contain slashes.

  @GET()
  @route('/storage/buckets/:slug/objects')
  @before(adminOnly)
  async listBucketObjects(req: Request, res: Response, next: NextFunction) {
    try {
      const objects = await this.di.StorageService.listObjects(
        req.params.slug,
        {
          prefix: typeof req.query.prefix === 'string' ? req.query.prefix : undefined,
          limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
          offset: req.query.offset === undefined ? undefined : Number(req.query.offset),
        },
        ADMIN_SCOPE
      );
      return apiResponse.successResponseWithData(res, 'OK', { objects });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/storage/buckets/:slug/objects/*')
  @before(adminOnly)
  async bucketObjectRaw(req: Request, res: Response, next: NextFunction) {
    try {
      const object = await this.di.StorageService.streamFileByKey(req.params.slug, objectKeyOf(req), ADMIN_SCOPE);
      return await sendStorageObject(res, object);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/storage/buckets/:slug/objects/*')
  @before(adminOnly)
  async removeBucketObject(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await this.di.StorageService.removeByKey(req.params.slug, objectKeyOf(req), ADMIN_SCOPE);
      return apiResponse.successResponseWithData(res, 'Deleted', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/storage/buckets/:slug/copy')
  @before(adminOnly)
  async copyBucketObject(req: Request, res: Response, next: NextFunction) {
    try {
      const { from, to, upsert } = parseTransfer(req.body);
      const result = await this.di.StorageService.copyObject(req.params.slug, from, to, ADMIN_SCOPE, { upsert });
      return apiResponse.successResponseWithData(res, 'Copied', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/storage/buckets/:slug/move')
  @before(adminOnly)
  async moveBucketObject(req: Request, res: Response, next: NextFunction) {
    try {
      const { from, to, upsert } = parseTransfer(req.body);
      const result = await this.di.StorageService.moveObject(req.params.slug, from, to, ADMIN_SCOPE, { upsert });
      return apiResponse.successResponseWithData(res, 'Moved', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ── Bucket CORS ────────────────────────────────────────────────────────────

  @GET()
  @route('/storage/buckets/:slug/cors')
  @before(adminOnly)
  async getBucketCors(req: Request, res: Response, next: NextFunction) {
    try {
      const bucket = await this.di.BucketService.getBySlug(req.params.slug);
      const cors = await this.di.BucketService.getCors(bucket.id);
      return res.status(200).json({ status: 1, message: 'OK', data: cors });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PUT()
  @route('/storage/buckets/:slug/cors')
  @before(adminOnly)
  async upsertBucketCors(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = bucketCorsSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpException(parsed.error.issues.map(issue => issue.message).join('; '), 400);
      const bucket = await this.di.BucketService.getBySlug(req.params.slug);
      const cors = await this.di.BucketService.upsertCors(bucket.id, parsed.data);
      return apiResponse.successResponseWithData(res, 'OK', cors);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/storage/buckets/:slug/cors')
  @before(adminOnly)
  async deleteBucketCors(req: Request, res: Response, next: NextFunction) {
    try {
      const bucket = await this.di.BucketService.getBySlug(req.params.slug);
      await this.di.BucketService.deleteCors(bucket.id);
      return apiResponse.successResponse(res, 'Deleted');
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ── Bucket tokens ──────────────────────────────────────────────────────────

  @GET()
  @route('/storage/buckets/:slug/tokens')
  @before(adminOnly)
  async listBucketTokens(req: Request, res: Response, next: NextFunction) {
    try {
      const bucket = await this.di.BucketService.getBySlug(req.params.slug);
      return apiResponse.successResponseWithData(res, 'OK', await this.di.BucketService.listTokens(bucket.id));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/storage/buckets/:slug/tokens')
  @before(adminOnly)
  async createBucketToken(req: Request, res: Response, next: NextFunction) {
    try {
      const bucket = await this.di.BucketService.getBySlug(req.params.slug);
      const { name, permissions, expiresAt } = req.body;
      const result = await this.di.BucketService.createToken(bucket.id, {
        name,
        permissions,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      });
      return apiResponse.successResponseWithData(res, 'Created', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/storage/buckets/:slug/tokens/:id')
  @before(adminOnly)
  async revokeBucketToken(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.BucketService.revokeToken(req.params.id);
      return apiResponse.successResponse(res, 'Revoked');
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ── Bucket webhooks ────────────────────────────────────────────────────────

  @GET()
  @route('/storage/buckets/:slug/webhooks')
  @before(adminOnly)
  async listBucketWebhooks(req: Request, res: Response, next: NextFunction) {
    try {
      const bucket = await this.di.BucketService.getBySlug(req.params.slug);
      return apiResponse.successResponseWithData(res, 'OK', await this.di.BucketService.listWebhooks(bucket.id));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/storage/buckets/:slug/webhooks')
  @before(adminOnly)
  async addBucketWebhook(req: Request, res: Response, next: NextFunction) {
    try {
      const bucket = await this.di.BucketService.getBySlug(req.params.slug);
      const wh = await this.di.BucketService.addWebhook(bucket.id, req.body);
      return apiResponse.successResponseWithData(res, 'Created', wh);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/storage/buckets/:slug/webhooks/:id')
  @before(adminOnly)
  async removeBucketWebhook(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.BucketService.removeWebhook(req.params.id);
      return apiResponse.successResponse(res, 'Deleted');
    } catch (error: unknown) {
      return next(error);
    }
  }
}
