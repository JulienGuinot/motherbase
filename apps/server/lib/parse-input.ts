import type { z } from 'zod';
import { HttpException } from '../exceptions/http-exception';

/**
 * Validate a request body or query with a zod schema, or throw a 400 naming
 * every field that failed. Controllers call this inside their `try`, so the
 * error reaches the global error middleware like any other.
 */
export function parseInput<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  const message = parsed.error.issues
    .map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ');
  throw new HttpException(message, 400);
}
