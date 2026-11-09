import type { Client } from 'pg';

interface Queryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

interface ImportTableManifest {
  name: string;
  rowCount?: string;
  rlsEnabled?: boolean;
  rlsForced?: boolean;
}

export interface ImportManifest {
  tables: ImportTableManifest[];
  constraints: string[];
  policies: string[];
}

export interface ImportVerificationResult {
  valid: boolean;
  checked: {
    tables: number;
    rows: boolean;
    constraints: number;
    policies: number;
  };
  errors: string[];
}

interface ManifestOptions {
  includeRows: boolean;
  includeSchemaObjects: boolean;
  schema?: string;
}
// Escapes (rather than validates) because these names come from the live catalog, not a caller.

const escapeIdent = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

/**
 * Capture only deterministic catalog state needed to prove that an import
 * restored the requested public objects. The optional schema exists solely so
 * integration tests can operate in disposable namespaces.
 */
export async function captureImportManifest(
  client: Pick<Client, 'query'> | Queryable,
  { includeRows, includeSchemaObjects, schema = 'public' }: ManifestOptions
): Promise<ImportManifest> {
  const { rows } = await client.query(
    `SELECT c.relname AS name,
            c.relrowsecurity AS "rlsEnabled",
            c.relforcerowsecurity AS "rlsForced"
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`,
    [schema]
  );

  const tables: ImportTableManifest[] = [];
  for (const row of rows as Array<{ name: string; rlsEnabled: boolean; rlsForced: boolean }>) {
    let rowCount: string | undefined;
    if (includeRows) {
      const count = await client.query(
        `SELECT count(*)::text AS count FROM ${escapeIdent(schema)}.${escapeIdent(row.name)}`
      );
      rowCount = String((count.rows[0] as { count?: string } | undefined)?.count ?? '0');
    }
    tables.push({
      name: row.name,
      rowCount,
      rlsEnabled: includeSchemaObjects ? Boolean(row.rlsEnabled) : undefined,
      rlsForced: includeSchemaObjects ? Boolean(row.rlsForced) : undefined,
    });
  }

  if (!includeSchemaObjects) return { tables, constraints: [], policies: [] };

  const [constraintsResult, policiesResult] = await Promise.all([
    client.query(
      // contype is "char", which has no unique || operator against text: cast every
      // part explicitly so the concatenation resolves on any server version.
      `SELECT c.relname::text || ':' || con.contype::text || ':' || pg_get_constraintdef(con.oid, true) AS signature
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
        ORDER BY c.relname, con.contype, con.conname`,
      [schema]
    ),
    client.query(
      `SELECT tablename::text || ':' || policyname::text || ':' || permissive::text || ':' || cmd::text || ':' ||
              array_to_string(roles, ',') || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') AS signature
         FROM pg_policies
        WHERE schemaname = $1
        ORDER BY tablename, policyname`,
      [schema]
    ),
  ]);

  return {
    tables,
    constraints: (constraintsResult.rows as Array<{ signature: string }>).map(row => row.signature),
    policies: (policiesResult.rows as Array<{ signature: string }>).map(row => row.signature),
  };
}

export function verifyImportManifest(expected: ImportManifest, actual: ImportManifest): ImportVerificationResult {
  const errors: string[] = [];
  const actualTables = new Map(actual.tables.map(table => [table.name, table]));

  for (const table of expected.tables) {
    const restored = actualTables.get(table.name);
    if (!restored) {
      errors.push(`missing table public.${table.name}`);
      continue;
    }
    if (table.rowCount !== undefined && restored.rowCount !== table.rowCount) {
      errors.push(
        `row count mismatch for public.${table.name}: expected ${table.rowCount}, got ${restored.rowCount ?? 'unknown'}`
      );
    }
    if (
      table.rlsEnabled !== undefined &&
      (restored.rlsEnabled !== table.rlsEnabled || restored.rlsForced !== table.rlsForced)
    ) {
      errors.push(`RLS status mismatch for public.${table.name}`);
    }
  }

  compareSignatures('constraint', expected.constraints, actual.constraints, errors);
  compareSignatures('policy', expected.policies, actual.policies, errors);

  return {
    valid: errors.length === 0,
    checked: {
      tables: expected.tables.length,
      rows: expected.tables.some(table => table.rowCount !== undefined),
      constraints: expected.constraints.length,
      policies: expected.policies.length,
    },
    errors,
  };
}

/**
 * The importer casts every `auth.uid()` in the dump to `(auth.uid())::uuid`,
 * because Supabase's returns `uuid` and this project's returns `text` (see
 * dump-compat). The restored policy therefore reads back from `pg_policies`
 * with that cast, while the source reads back without it, and a verbatim
 * comparison would report every RLS policy as changed.
 *
 * The cast is deliberate and meaning-preserving, so it is removed from both
 * sides before comparing. Any OTHER difference in the expression still fails.
 */
const IMPORTED_AUTH_UID_CAST = /\(auth\.uid\(\)\)::uuid|auth\.uid\(\)::uuid/g;

function canonicalize(signature: string): string {
  return signature.replace(IMPORTED_AUTH_UID_CAST, 'auth.uid()');
}

function compareSignatures(kind: string, expected: string[], actual: string[], errors: string[]): void {
  const remaining = new Set(actual.map(canonicalize));
  for (const signature of expected) {
    const canonical = canonicalize(signature);
    if (remaining.has(canonical)) remaining.delete(canonical);
    else errors.push(`missing or changed ${kind}: ${signature}`);
  }
}
