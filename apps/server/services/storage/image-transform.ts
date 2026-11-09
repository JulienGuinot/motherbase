import { createHmac } from 'node:crypto';
import type { Readable } from 'stream';
import sharp, { type FitEnum } from 'sharp';
import { z } from 'zod';
import { HttpException } from '../../exceptions/http-exception';
import { safeEqual } from '../../lib/safe-equal';

/**
 * Image transformations, in the shape Supabase's `/render/image` takes them:
 * `?width=&height=&resize=cover|contain|fill&quality=&format=origin|webp|avif`.
 *
 * The limits are Supabase's own, so a URL written against a Supabase project
 * behaves the same here: 1 to 2500 px per side, quality 20 to 100.
 */
export const MAX_TRANSFORM_DIMENSION = 2500;

const dimension = z.coerce.number().int().min(1).max(MAX_TRANSFORM_DIMENSION);

const transformSchema = z.object({
  width: dimension.optional(),
  height: dimension.optional(),
  resize: z.enum(['cover', 'contain', 'fill']).optional(),
  quality: z.coerce.number().int().min(20).max(100).optional(),
  format: z.enum(['origin', 'webp', 'avif']).optional(),
});

export type TransformOptions = z.infer<typeof transformSchema>;

/** Sources sharp decodes. SVG is left out on purpose: rasterising it runs a renderer over caller-supplied XML. */
const TRANSFORMABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/tiff', 'image/heic', 'image/heif']);

const FIT: Record<NonNullable<TransformOptions['resize']>, keyof FitEnum> = {
  cover: 'cover',
  // Supabase's `contain` keeps the whole image inside the box without padding,
  // which is sharp's `inside`, not its `contain` (that one letterboxes).
  contain: 'inside',
  fill: 'fill',
};

/**
 * Read transform options out of a query string. Only the five transform keys
 * are looked at, so the same query can carry `token` or `download` alongside.
 * Returns `null` when none are present, which callers read as "serve the
 * original".
 */
export function parseTransformOptions(query: Record<string, unknown>): TransformOptions | null {
  const picked = Object.fromEntries(
    Object.keys(transformSchema.shape)
      .filter(key => query[key] !== undefined && query[key] !== '')
      .map(key => [key, query[key]]),
  );
  if (!Object.keys(picked).length) return null;
  const parsed = transformSchema.safeParse(picked);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpException(`Invalid transform option "${issue.path.join('.')}": ${issue.message}`, 400);
  }
  return parsed.data;
}

/** The query string for `options`, in a fixed key order so it can be signed. */
export function transformQuery(options: TransformOptions): URLSearchParams {
  const query = new URLSearchParams();
  for (const key of Object.keys(transformSchema.shape) as Array<keyof TransformOptions>) {
    if (options[key] !== undefined) query.set(key, String(options[key]));
  }
  return query;
}

/**
 * The output format. An explicit `format` wins; without one the image is
 * served as WebP to clients that say they accept it, which is what Supabase
 * does, and in its original format otherwise.
 */
export function outputFormat(options: TransformOptions, sourceMime: string, accept = ''): string {
  if (options.format === 'webp' || options.format === 'avif') return `image/${options.format}`;
  if (options.format === 'origin') return sourceMime;
  return accept.includes('image/webp') ? 'image/webp' : sourceMime;
}

export function isTransformable(mime: string): boolean {
  return TRANSFORMABLE.has(mime.toLowerCase());
}

/**
 * Pipe `source` through sharp. Streaming end to end: the source is never
 * buffered whole in this process, which matters at 25 MB times concurrency.
 */
export function transformImage(source: Readable, options: TransformOptions, mime: string): Readable {
  const quality = options.quality ?? 80;
  let pipeline = sharp({ failOn: 'error' }).rotate();
  if (options.width || options.height) {
    pipeline = pipeline.resize({
      width: options.width,
      height: options.height,
      fit: FIT[options.resize ?? 'cover'],
    });
  }
  switch (mime) {
    case 'image/webp': pipeline = pipeline.webp({ quality }); break;
    case 'image/avif': pipeline = pipeline.avif({ quality }); break;
    case 'image/jpeg': pipeline = pipeline.jpeg({ quality, mozjpeg: true }); break;
    case 'image/png': pipeline = pipeline.png({ quality }); break;
    // Anything else (gif, tiff, heif) keeps sharp's default encoder for it.
  }
  // A decode error on the source surfaces on the output stream, where the
  // response pipeline sees it, instead of as an unhandled error on the input.
  source.on('error', error => pipeline.destroy(error));
  return source.pipe(pipeline);
}

interface RenderClaim {
  bucket: string;
  key: string;
  options: TransformOptions;
}

/**
 * A signed render URL grants reading one object, at one transform, until one
 * time. All three are in the signature: a token for a 100 px thumbnail is not
 * a token for the original.
 */
export function signRenderToken(claim: RenderClaim, expiresAt: number, secret: string): string {
  const signature = createHmac('sha256', secret)
    .update(JSON.stringify(['storage-render-v1', claim.bucket, claim.key, transformQuery(claim.options).toString(), expiresAt]))
    .digest('base64url');
  return `${expiresAt}.${signature}`;
}

export function verifyRenderToken(token: unknown, claim: RenderClaim, secret: string, now = Date.now()): boolean {
  if (typeof token !== 'string') return false;
  const expiresAt = Number(token.split('.')[0]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  return safeEqual(token, signRenderToken(claim, expiresAt, secret));
}
