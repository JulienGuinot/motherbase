import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { renderTypescript } from '../services/admin/typegen/render';
import type { TypegenCatalog, TypegenRelationship } from '../services/admin/typegen/types';

/**
 * The integration test compiles the emitter's output against a real catalog,
 * but its fixture tables have at most one foreign key each. Two is where the
 * Relationships tuple needs a separator, so that case is pinned here, without
 * Postgres: the emitter is a pure function of the catalog.
 */

function fk(name: string, referencedRelation: string): TypegenRelationship {
  return { foreignKeyName: name, columns: [`${referencedRelation}_id`], isOneToOne: false, referencedRelation, referencedColumns: ['id'] };
}

const catalog: TypegenCatalog = {
  schema: 'public',
  tables: [
    {
      name: 'enrollments',
      kind: 'table',
      primaryKey: [],
      relationships: [fk('enrollments_group_id_fkey', 'groups'), fk('enrollments_member_id_fkey', 'members')],
      rlsEnabled: false,
      columns: [],
    },
  ],
  views: [],
  functions: [],
  enums: [],
  compositeTypes: [],
};

function syntaxErrors(source: string): string[] {
  const { diagnostics = [] } = ts.transpileModule(source, { reportDiagnostics: true });
  return diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('typegen: TypeScript emitter syntax', () => {
  it('separates the entries of a multi-FK Relationships tuple', () => {
    const generated = renderTypescript(catalog);
    expect(syntaxErrors(generated)).toEqual([]);
    expect(generated).toContain('referencedRelation: "groups"');
    expect(generated).toContain('referencedRelation: "members"');
  });
});

describe('typegen: project resources', () => {
  const empty: TypegenCatalog = { ...catalog, tables: [] };

  it('renders edge function routes and bucket slugs as name unions', () => {
    const generated = renderTypescript(empty, { edgeFunctions: ['send-email', 'stripe-webhook'], buckets: ['avatars'] });
    expect(syntaxErrors(generated)).toEqual([]);
    expect(generated).toContain(
      'export type Database = {\n'
      + '  __InternalMotherbase: {\n'
      + '    EdgeFunctions: "send-email" | "stripe-webhook"\n'
      + '    Buckets: "avatars"\n'
      + '  }\n'
      + '  public: {',
    );
  });

  // `never` and not an empty union, which would not parse.
  it('renders a project with neither as never', () => {
    const generated = renderTypescript(empty);
    expect(syntaxErrors(generated)).toEqual([]);
    expect(generated).toContain('    EdgeFunctions: never\n    Buckets: never\n');
  });
});
