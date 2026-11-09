import { z } from 'zod';

const origin = z.string().trim().refine(value => {
  if (value === '*') return true;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}, 'Use an HTTP(S) origin without a path, or *');

export const bucketCorsSchema = z.object({
  allowedOrigins: z.array(origin).max(100),
  allowedMethods: z.array(z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])).min(1),
  allowedHeaders: z.array(z.string().trim().regex(/^[!#$%&'*+.^_`|~0-9a-z-]+$/i, 'Invalid header name')).min(1).max(100),
  maxAgeSec: z.number().int().min(0).max(86400).default(3600),
});
