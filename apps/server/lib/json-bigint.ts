/**
 * JSON.stringify throws on BigInt, and Prisma hands back BigInt for `BigInt?`
 * columns (Bucket.quotaBytes) and for raw SUM() results. Every route returning
 * one 500s with "Do not know how to serialize a BigInt", so this is installed
 * once as express's `json replacer` rather than mapped per controller.
 *
 * Numbers within the safe integer range go out as numbers, which is what
 * clients already expect (the studio types quotaBytes as `number | null`).
 * Beyond it a Number would silently lose precision, so those go out as strings.
 */
export function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value !== 'bigint') return value;
  const safe = value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER);
  return safe ? Number(value) : value.toString();
}
