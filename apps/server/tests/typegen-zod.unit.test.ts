import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { renderZod } from '../services/admin/typegen/render-zod';
import type { TypegenCatalog, TypegenColumn } from '../services/admin/typegen/types';

/**
 * The zod emitter is a pure function of the catalog, so it is testable without
 * Postgres. What matters is not the exact text but that the emitted schema
 * accepts and rejects the same values the REST layer does: a generated `Insert`
 * schema that rejects a valid insert is worse than no schema at all.
 */

function column(over: Partial<TypegenColumn> & { name: string }): TypegenColumn {
  return {
    pgType: 'text',
    formattedType: 'text',
    tsType: 'string',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    isPk: false,
    isArray: false,
    enumRef: null,
    compositeRef: null,
    ...over,
  };
}

const catalog: TypegenCatalog = {
  schema: 'public',
  tables: [
    {
      name: 'order_items',
      kind: 'table',
      primaryKey: ['id'],
      relationships: [],
      rlsEnabled: true,
      columns: [
        column({ name: 'id', tsType: 'string', isPk: true, hasDefault: true, isGenerated: true }),
        column({ name: 'title' }),
        column({ name: 'quantity', tsType: 'number', hasDefault: true }),
        column({ name: 'note', nullable: true }),
        column({ name: 'status', tsType: 'string', enumRef: 'order_status' }),
        column({ name: 'tags', tsType: 'string[]', isArray: true, nullable: true }),
        column({ name: 'payload', tsType: 'Json', nullable: true }),
      ],
    },
  ],
  views: [
    {
      name: 'order_totals',
      kind: 'view',
      primaryKey: [],
      relationships: [],
      rlsEnabled: false,
      columns: [column({ name: 'total', tsType: 'number', nullable: true })],
    },
  ],
  functions: [],
  enums: [{ name: 'order_status', values: ['open', 'paid'] }],
  compositeTypes: [],
};

/** Evaluate the emitted module and hand back its exported schemas. */
function load(source: string): Record<string, z.ZodTypeAny> {
  const body = source
    .split('\n')
    .filter(line => !line.startsWith('import '))
    .join('\n')
    .replace(/export const /g, 'const ');
  const names = Array.from(source.matchAll(/^export const (\w+)/gm), m => m[1]);
  const factory = new Function('z', `${body}\nreturn { ${names.join(', ')} };`);
  return factory(z) as Record<string, z.ZodTypeAny>;
}

describe('renderZod', () => {
  const source = renderZod(catalog);
  const schemas = load(source);

  it('names one Row, Insert and Update per table, and a Row per view', () => {
    expect(Object.keys(schemas).sort()).toEqual([
      'OrderItemsInsert',
      'OrderItemsRow',
      'OrderItemsUpdate',
      'OrderStatusEnum',
      'OrderTotalsRow',
    ]);
  });

  it('accepts a row the database would produce', () => {
    const row = {
      id: 'a',
      title: 't',
      quantity: 2,
      note: null,
      status: 'paid',
      tags: null,
      payload: { any: 'thing' },
    };
    expect(schemas.OrderItemsRow.safeParse(row).success).toBe(true);
  });

  it('rejects a value outside the enum, which is the point of generating this', () => {
    const parsed = schemas.OrderItemsRow.safeParse({
      id: 'a',
      title: 't',
      quantity: 2,
      note: null,
      status: 'refunded',
      tags: null,
      payload: null,
    });
    expect(parsed.success).toBe(false);
  });

  it('omits generated columns from Insert and makes defaulted ones optional', () => {
    // Exactly what the REST layer accepts: no id, no quantity, no note.
    expect(schemas.OrderItemsInsert.safeParse({ title: 't', status: 'open' }).success).toBe(true);
    // Supplying a generated column is a write Postgres refuses, so the schema does too.
    const withId = schemas.OrderItemsInsert.safeParse({ id: 'a', title: 't', status: 'open' });
    expect(withId.success).toBe(true); // unknown keys are stripped, not rejected
    expect((withId as { data: Record<string, unknown> }).data.id).toBeUndefined();
    // A required column with no default is still required.
    expect(schemas.OrderItemsInsert.safeParse({ status: 'open' }).success).toBe(false);
  });

  it('makes every Update field optional, because a PATCH is partial', () => {
    expect(schemas.OrderItemsUpdate.safeParse({}).success).toBe(true);
    expect(schemas.OrderItemsUpdate.safeParse({ quantity: 'two' }).success).toBe(false);
  });

  it('renders deterministically', () => {
    expect(renderZod(catalog)).toBe(source);
    expect(source.endsWith('\n')).toBe(true);
  });
});
