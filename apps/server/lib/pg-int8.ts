import { types } from 'pg';

/**
 * `int8` (bigint, and therefore every `bigserial` primary key) arrives from
 * node-postgres as a string, because 2^63 does not fit in a JS number. It went
 * out on the wire that way too, so `id` was declared `bigserial` in the schema,
 * typed `number` by the type generator, and arrived as `"45"`. A mismatch that
 * only shows up as a `===` that never matches.
 *
 * supabase-js, whose API this SDK mirrors, returns a number. So does the rest
 * of this codebase already: `lib/json-bigint` sends Prisma BigInts out as
 * numbers within the safe range and as strings beyond it. Same rule here, so
 * the two halves of the API agree and precision is still never silently lost.
 */
export const INT8_OID = 20;

export function parseInt8(value: string | null): number | string | null {
  if (value === null) return null;
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : value;
}

export function installInt8Parser(): void {
  types.setTypeParser(INT8_OID, parseInt8 as (value: string) => unknown);
}
