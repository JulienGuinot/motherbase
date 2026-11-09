/**
 * Column names that must never leave the server through the admin API.
 * Used by the table editor and user screens to strip secrets from payloads.
 */
export const SENSITIVE_FIELDS = [
  'passwordHash',
  // Better Auth credential account hash + token columns.
  'password',
  'accessToken',
  'refreshToken',
  'idToken',
  'tokenHash',
  'secretCode',
  'secretCodeExpiryDate',
] as const;

const sensitiveSet = new Set<string>(SENSITIVE_FIELDS);

export const isSensitiveField = (name: string): boolean => sensitiveSet.has(name);

/**
 * Returns a deep copy of `row` with all sensitive keys removed at every level,
 * so secrets nested inside related records (e.g. an included relation) are also
 * stripped. Null/undefined inputs and non-objects pass through unchanged.
 */
export const maskRow = <T = any>(row: T): T => {
  if (Array.isArray(row)) return row.map(item => maskRow(item)) as unknown as T;
  if (!row || typeof row !== 'object' || row instanceof Date) return row;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row as Record<string, any>)) {
    if (sensitiveSet.has(k)) continue;
    out[k] = v && typeof v === 'object' ? maskRow(v) : v;
  }
  return out as unknown as T;
};
