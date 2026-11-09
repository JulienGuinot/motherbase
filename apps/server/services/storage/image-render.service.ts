import { FileVisibility } from '@prisma/client';
import { HTTP_ROUTES } from '@motherbase/contracts';
import BaseContext from '../../context/base-context';
import { HttpException } from '../../exceptions/http-exception';
import { env } from '../../config/env';
import type { StorageObjectStream } from '../../helpers/storage-stream.helper';
import type { FileAccessScope } from './storage.service';
import { MAX_DOWNLOAD_URL_TTL, normalizeObjectKey } from './storage.service';
import { encodeObjectPath } from './storage.types';
import {
  isTransformable,
  outputFormat,
  signRenderToken,
  transformImage,
  transformQuery,
  verifyRenderToken,
  type TransformOptions,
} from './image-transform';

/** A rendered image. `vary` is set when the format was negotiated from `Accept`, so caches key on it. */
type RenderedImage = StorageObjectStream & { cacheControl: string };

const RENDER_ROUTE = `${HTTP_ROUTES.storageV1}/render/image`;
const CACHE_SECONDS = 3600;

/**
 * `/render/image/{public,authenticated,sign}`: an object, resized and
 * re-encoded on the way out.
 *
 * Authorization is never decided here. Each mode reads the object through the
 * same StorageService call its plain-download twin uses, so a transform can
 * only ever show a caller an object they could already download. This class
 * adds the project switch, the source size ceiling and the sharp pipeline.
 */
export class ImageRenderService extends BaseContext {
  private async config(): Promise<{ enabled: boolean; maxSourceBytes: number }> {
    const cfg = await this.di.SettingsService.get<{ enabled?: boolean; maxSourceBytes?: number }>('storage.imageTransform');
    return { enabled: cfg?.enabled !== false, maxSourceBytes: Number(cfg?.maxSourceBytes) || 26_214_400 };
  }

  /** Public bucket objects, no credentials: the render twin of `getPublicUrl`. */
  async renderPublic(bucketSlug: string, key: string, options: TransformOptions, accept?: string) {
    const bucket = await this.di.BucketService.getBySlug(bucketSlug);
    if (bucket.visibility !== FileVisibility.public) throw new HttpException('Bucket not found', 404);
    return this.render(
      () => this.di.StorageService.streamFileByKey(bucketSlug, key, { bucketId: bucket.id }),
      options,
      accept,
      'public',
    );
  }

  /** Any object the caller can read: the render twin of `download()`. */
  async renderAuthenticated(bucketSlug: string, key: string, scope: FileAccessScope, options: TransformOptions, accept?: string) {
    return this.render(() => this.di.StorageService.streamFileByKey(bucketSlug, key, scope), options, accept, 'private');
  }

  /** A URL minted by `signedUrl`: the token already carries the authorization. */
  async renderSigned(bucketSlug: string, key: string, token: unknown, options: TransformOptions, accept?: string) {
    if (!verifyRenderToken(token, { bucket: bucketSlug, key: normalizeObjectKey(key), options }, env.JWT_SECRET)) {
      throw new HttpException('Invalid or expired signature', 400);
    }
    return this.render(
      () => this.di.StorageService.streamFileByKey(bucketSlug, key, { caller: { serviceRole: true } }),
      options,
      accept,
      'private',
    );
  }

  /** Admin preview (Studio thumbnails), addressed by file id. Admin-gated at the route. */
  async renderAdmin(fileId: string, options: TransformOptions, accept?: string) {
    return this.render(() => this.di.StorageService.adminStreamFile(fileId), options, accept, 'private');
  }

  /**
   * A time-limited render URL, for `createSignedUrl(path, exp, { transform })`.
   *
   * Signing is authorized like any other download URL: `statObject` refuses an
   * object the caller could not read, so the token cannot be used to widen
   * access, only to hand it on.
   */
  async signedUrl(bucketSlug: string, key: string, scope: FileAccessScope, options: TransformOptions, expiresInSec = CACHE_SECONDS) {
    if (!(await this.config()).enabled) throw new HttpException('Image transformations are disabled for this project', 403);
    if (expiresInSec > MAX_DOWNLOAD_URL_TTL) throw new HttpException('expiresIn is too long', 400);
    const info = await this.di.StorageService.statObject(bucketSlug, key, scope);
    const expiresAt = Date.now() + expiresInSec * 1000;
    const query = transformQuery(options);
    query.set('token', signRenderToken({ bucket: bucketSlug, key: info.name, options }, expiresAt, env.JWT_SECRET));
    const host = env.BASE_HOST.startsWith('http') ? env.BASE_HOST : `http://${env.BASE_HOST}`;
    return {
      url: `${host}${RENDER_ROUTE}/sign/${encodeURIComponent(bucketSlug)}/${encodeObjectPath(info.name)}?${query}`,
      expiresAt: new Date(expiresAt),
    };
  }

  private async render(
    open: () => Promise<StorageObjectStream>,
    options: TransformOptions,
    accept: string | undefined,
    cache: 'public' | 'private',
  ): Promise<RenderedImage> {
    const { enabled, maxSourceBytes } = await this.config();
    if (!enabled) throw new HttpException('Image transformations are disabled for this project', 403);

    const source = await open();
    const sourceMime = source.mime.toLowerCase();
    if (!isTransformable(sourceMime)) {
      source.body.destroy();
      throw new HttpException(`Cannot transform an object of type ${source.mime}`, 400);
    }
    if (source.contentLength > maxSourceBytes) {
      source.body.destroy();
      throw new HttpException(`Source image is larger than ${maxSourceBytes} bytes`, 413);
    }

    const mime = outputFormat(options, sourceMime, accept);
    return {
      body: transformImage(source.body, options, mime),
      // The encoded size is not known until sharp is done, so no length.
      contentLength: -1,
      mime,
      cacheControl: `${cache}, max-age=${CACHE_SECONDS}`,
      vary: options.format ? undefined : 'Accept',
    };
  }
}
