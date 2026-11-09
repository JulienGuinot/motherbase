import { Request } from 'express';
import { HTTP_ROUTES } from '@motherbase/contracts';
import type { BucketService } from '../services/storage/bucket.service';

/**
 * Paths whose next segment is a bucket slug, so the bucket's own CORS rules
 * apply: the storage API, and Supabase's public image render URL (which a
 * browser loads cross-origin exactly like a public object).
 */
const BUCKET_PATH_PREFIXES = [`${HTTP_ROUTES.storage}/`, `${HTTP_ROUTES.storageV1}/render/image/public/`];

/** The bucket slug a request path addresses, or null when it addresses none. */
export function bucketSlugOf(path: string): string | null {
  const prefix = BUCKET_PATH_PREFIXES.find(candidate => path.startsWith(candidate));
  if (!prefix) return null;
  return decodeURIComponent(path.slice(prefix.length).split('/')[0]) || null;
}

/** Runs inside the global CORS delegate, before it answers OPTIONS. */
export function createBucketCorsLoader(service: Pick<BucketService, 'getBySlug' | 'getCors'>) {
  return async (req: Request) => {
    const slug = bucketSlugOf(req.path);
    if (!slug) return null;
    const bucket = await service.getBySlug(slug);
    return service.getCors(bucket.id);
  };
}
