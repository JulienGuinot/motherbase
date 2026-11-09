import type { Response } from 'express';
import type { Readable } from 'stream';
import { pipeline } from 'stream/promises';

export interface StorageObjectStream {
  body: Readable;
  contentLength: number;
  mime: string;
  cacheControl?: string;
  vary?: string;
}

/** Types a browser renders without running script. Everything else is downloaded. */
const INLINE_SAFE = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|audio\/|video\/|application\/pdf$)/i;

/**
 * Headers that keep user-supplied bytes inert on the API's own origin.
 *
 * The MIME type is whatever the uploader claimed, and the files are served from
 * the same origin as `/api/auth/*`, so an `text/html` or `image/svg+xml` upload
 * would otherwise run script as that origin. Unsafe types are forced to download
 * and every response is sandboxed with no sources, so even a type that slips
 * through cannot execute or load anything.
 */
export function userContentHeaders(mime: string | undefined | null): Record<string, string> {
  const type = (mime ?? '').split(';')[0].trim();
  const headers: Record<string, string> = { 'X-Content-Type-Options': 'nosniff' };
  if (!INLINE_SAFE.test(type)) headers['Content-Disposition'] = 'attachment';
  // A PDF viewer does not load under a sandboxed document; it is isolated by the browser anyway.
  if (!/^application\/pdf$/i.test(type)) headers['Content-Security-Policy'] = "sandbox; default-src 'none'";
  return headers;
}

/** Pipe a storage object to HTTP while preserving Node stream backpressure. */
export async function sendStorageObject(res: Response, object: StorageObjectStream): Promise<void> {
  res.setHeader('Content-Type', object.mime);
  for (const [name, value] of Object.entries(userContentHeaders(object.mime))) res.setHeader(name, value);
  if (object.cacheControl) res.setHeader('Cache-Control', object.cacheControl);
  if (object.vary) res.setHeader('Vary', object.vary);
  if (object.contentLength >= 0) res.setHeader('Content-Length', object.contentLength);
  await pipeline(object.body, res);
}
