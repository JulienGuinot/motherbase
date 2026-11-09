import type { ZodType } from 'zod';
import { HttpException } from '../exceptions/http-exception';

/**
 * Validate a request body (or query) against a zod schema, or fail with a 400
 * that names the offending field.
 *
 * The first issue is enough: a form sends one bad field at a time, and a list
 * of every issue reads worse in a toast than the one that needs fixing.
 */
export function parseBody<T>(schema: ZodType<T, unknown>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue.path.join('.');
  throw new HttpException(field ? `${field}: ${issue.message}` : issue.message, 400);
}
