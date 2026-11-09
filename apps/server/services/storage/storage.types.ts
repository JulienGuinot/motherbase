import { FileVisibility } from '@prisma/client';
import type { Readable } from 'stream';

type Visibility = FileVisibility;

export interface PutObjectInput {
  bucket: string;
  key: string;
  body: Readable;
  contentLength: number;
  contentType?: string;
  visibility: Visibility;
}

/**
 * Pluggable storage backend. Implemented by the local-disk driver (dev) and the
 * S3-compatible driver (AWS S3, MinIO, Cloudflare R2, ...).
 */
export interface ObjectData {
  body: Readable;
  contentLength: number;
  contentType?: string;
}

/** An inclusive byte range, as an HTTP `Range: bytes=start-end` names it. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface ObjectMetadata {
  contentLength: number;
  contentType?: string;
}

export interface SignedUploadInput {
  bucket: string;
  key: string;
  expiresInSec: number;
  contentLength: number;
  contentType?: string;
}

export interface IStorageDriver {
  put(input: PutObjectInput): Promise<void>;
  delete(bucket: string, key: string): Promise<void>;
  /** Open an object (or `range` of it) as a backpressure-aware stream. */
  getObject(bucket: string, key: string, range?: ByteRange): Promise<ObjectData>;
  /** Read object metadata without downloading its body. */
  headObject(bucket: string, key: string): Promise<ObjectMetadata>;
  /** Time-limited URL to read a (typically private) object. */
  getSignedDownloadUrl(bucket: string, key: string, expiresInSec: number): Promise<string>;
  /** Time-limited URL the client can PUT directly to (direct-to-storage upload). */
  getSignedUploadUrl(input: SignedUploadInput): Promise<string>;
  /** Stable public URL for a public-visibility object. */
  publicUrl(bucket: string, key: string): string;
}

/**
 * Percent-encode an object key for use in a URL path, one segment at a time.
 *
 * Keys legitimately contain spaces, Unicode, `#`, `?` and `%`. Concatenated raw
 * into a URL, everything after a `?` becomes a query string and everything after
 * a `#` a fragment, so the browser asks for a different object than the one the
 * key names. The separators stay separators: a key is a path, not one opaque
 * component.
 */
export function encodeObjectPath(key: string): string {
  return String(key).split('/').map(encodeURIComponent).join('/');
}
