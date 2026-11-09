import { describe, expect, it, vi } from 'vitest';
import {
  captureImportManifest,
  verifyImportManifest,
  type ImportManifest,
} from '../services/admin/import-verification';

const expected: ImportManifest = {
  tables: [{ name: 'todos', rowCount: '2', rlsEnabled: true, rlsForced: false }],
  constraints: ['todos:p:PRIMARY KEY (id)', 'todos:u:UNIQUE (slug)'],
  policies: ['todos:read_own:PERMISSIVE:SELECT:public:(owner_id = auth.uid()):'],
};

describe('import verification', () => {
  it('accepts a restored manifest with matching data and security objects', () => {
    expect(verifyImportManifest(expected, structuredClone(expected))).toEqual({
      valid: true,
      checked: { tables: 1, rows: true, constraints: 2, policies: 1 },
      errors: [],
    });
  });

  it('reports missing data, changed constraints and RLS without masking failures', () => {
    const result = verifyImportManifest(expected, {
      tables: [{ name: 'todos', rowCount: '1', rlsEnabled: false, rlsForced: false }],
      constraints: ['todos:p:PRIMARY KEY (other_id)'],
      policies: [],
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'row count mismatch for public.todos: expected 2, got 1',
        'RLS status mismatch for public.todos',
        'missing or changed constraint: todos:p:PRIMARY KEY (id)',
        'missing or changed policy: todos:read_own:PERMISSIVE:SELECT:public:(owner_id = auth.uid()):',
      ])
    );
  });

  // The importer casts auth.uid() to uuid on the way in, so the restored policy
  // reads back with a cast the source never had. That is not a difference.
  it('accepts the auth.uid() cast the importer itself applies', () => {
    const restored: ImportManifest = {
      ...structuredClone(expected),
      policies: ['todos:read_own:PERMISSIVE:SELECT:public:(owner_id = (auth.uid())::uuid):'],
    };

    expect(verifyImportManifest(expected, restored).valid).toBe(true);
  });

  it('still reports a policy that differs beyond that cast', () => {
    const restored: ImportManifest = {
      ...structuredClone(expected),
      policies: ['todos:read_own:PERMISSIVE:SELECT:public:(other_id = (auth.uid())::uuid):'],
    };

    const result = verifyImportManifest(expected, restored);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      'missing or changed policy: todos:read_own:PERMISSIVE:SELECT:public:(owner_id = auth.uid()):',
    ]);
  });

  it('captures catalog objects and quotes table identifiers for exact row counts', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM pg_class')) {
        return { rows: [{ name: 'odd"table', rlsEnabled: true, rlsForced: false }] };
      }
      if (sql.includes('count(*)')) return { rows: [{ count: '4' }] };
      if (sql.includes('FROM pg_constraint')) return { rows: [{ signature: 'constraint' }] };
      if (sql.includes('FROM pg_policies')) return { rows: [{ signature: 'policy' }] };
      return { rows: [] };
    });

    const manifest = await captureImportManifest(
      { query },
      {
        includeRows: true,
        includeSchemaObjects: true,
        schema: 'copy schema',
      }
    );

    expect(manifest).toEqual({
      tables: [{ name: 'odd"table', rowCount: '4', rlsEnabled: true, rlsForced: false }],
      constraints: ['constraint'],
      policies: ['policy'],
    });
    expect(query).toHaveBeenCalledWith('SELECT count(*)::text AS count FROM "copy schema"."odd""table"');
  });
});
