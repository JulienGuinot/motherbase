import { HttpException } from '../../exceptions/http-exception';

/** The constraints one upload is checked against. */
export interface UploadLimits {
  maxBytes: number;
  /**
   * Every list the MIME type has to satisfy. The project allowlist and the
   * bucket's are both authoritative, so a type must clear each non-empty one:
   * a bucket can narrow what the project accepts but never widen it.
   */
  mimeLists: string[][];
}

/** The per-bucket half, as `storage.buckets` stores it. */
export interface BucketLimits {
  fileSizeLimit: bigint | number | null;
  allowedMimeTypes: string[];
}

/** True when `mime` matches the allowlist (empty = allow all). Supports `type/*`. */
export function mimeAllowed(mime: string | undefined, allowed: string[]): boolean {
  if (!allowed.length || !mime) return true;
  const m = mime.toLowerCase();
  return allowed.some(a => a === m || (a.endsWith('/*') && m.startsWith(a.slice(0, -1))));
}

/** `"image/*, application/pdf"` or an array of the same, normalised. */
export function parseMimeList(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return items.map(item => String(item).trim().toLowerCase()).filter(Boolean);
}

/**
 * The tighter of the project limits and the bucket's. `project.maxBytes` is
 * already capped by MAX_UPLOAD_MB, so the smallest positive value wins.
 */
export function effectiveUploadLimits(
  project: { maxBytes: number; allowedMimeTypes: string[] },
  bucket?: BucketLimits | null,
): UploadLimits {
  const bucketMax = bucket?.fileSizeLimit == null ? 0 : Number(bucket.fileSizeLimit);
  return {
    maxBytes: bucketMax > 0 ? Math.min(bucketMax, project.maxBytes) : project.maxBytes,
    mimeLists: [project.allowedMimeTypes, bucket?.allowedMimeTypes ?? []].filter(list => list.length > 0),
  };
}

/** Refuse `size`/`mime` outside `limits`; returns the validated size. */
export function assertWithinLimits(limits: UploadLimits, rawSize: unknown, mime?: string): number {
  if (typeof rawSize !== 'number' || !Number.isSafeInteger(rawSize) || rawSize < 0 || rawSize > limits.maxBytes) {
    throw new HttpException(`size must be a safe integer between 0 and ${limits.maxBytes} bytes`, 400);
  }
  if (!limits.mimeLists.every(list => mimeAllowed(mime, list))) {
    throw new HttpException(`file type "${mime}" is not allowed`, 400);
  }
  return rawSize;
}

const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

/**
 * A bucket size limit as supabase-js sends it: a byte count, or a string with a
 * unit (`"20MB"`, `"1.5 GB"`). `null`/`''`/`0` clear the limit.
 */
export function parseSizeLimit(raw: unknown): bigint | null {
  if (raw === null || raw === undefined || raw === '' || raw === 0) return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(String(raw));
  if (!match) throw new HttpException(`Invalid file size limit: ${String(raw)}`, 400);
  const bytes = Math.floor(Number(match[1]) * SIZE_UNITS[(match[2] ?? 'b').toLowerCase()]);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new HttpException(`Invalid file size limit: ${String(raw)}`, 400);
  return bytes === 0 ? null : BigInt(bytes);
}
