// Server-side row filtering for the Table Editor. Pure, side-effect-free
// builders shared by both storage paths in AdminService.listRows:
//   - buildRowFilterSql  -> parameterised WHERE clause for dynamic (raw SQL) tables
//   - buildRowFilterPrismaWhere -> Prisma `where` object for schema-backed models
//
// Every column name is validated against the table's own field list before it
// reaches SQL, and every value travels as a bound parameter. No user string is
// ever interpolated into the query text.

import { HttpException } from '../../exceptions/http-exception';
import type { FieldMeta } from './admin.service';

/** Comparison operators exposed in the filter bar. Order = UI display order. */
const FILTER_OPERATORS = [
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is_null', 'not_null',
] as const;

type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface RowFilter {
  column: string;
  op: FilterOperator;
  value?: string;
}

const NUMERIC_TYPES = new Set([
  'int', 'integer', 'bigint', 'smallint', 'float', 'float8', 'double', 'decimal',
  'numeric', 'real', 'serial', 'bigserial',
]);
const BOOLEAN_TYPES = new Set(['bool', 'boolean']);

type ValueCategory = 'number' | 'boolean' | 'text';

function categorize(fieldType: string): ValueCategory {
  const t = fieldType.toLowerCase().replace(/\(.*\)$/, '').trim();
  if (NUMERIC_TYPES.has(t)) return 'number';
  if (BOOLEAN_TYPES.has(t)) return 'boolean';
  return 'text';
}

/** Coerce a raw string value to the JS type Postgres/Prisma expects for the column. */
function coerce(raw: string, category: ValueCategory, column: string): string | number | boolean {
  if (category === 'number') {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new HttpException(`Filter on "${column}" expects a number, got "${raw}"`, 400);
    return n;
  }
  if (category === 'boolean') return raw === 'true' || raw === '1' || raw === 't';
  return raw;
}

/** Parse the `filters` query param (a JSON array) into validated RowFilter[]. */
export function parseRowFilters(raw: unknown): RowFilter[] {
  if (raw == null || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new HttpException('Invalid filters parameter: expected JSON', 400);
  }
  if (!Array.isArray(parsed)) throw new HttpException('Invalid filters parameter: expected an array', 400);
  return parsed.map((f: any) => {
    if (!f || typeof f.column !== 'string' || typeof f.op !== 'string') {
      throw new HttpException('Each filter needs a "column" and an "op"', 400);
    }
    if (!FILTER_OPERATORS.includes(f.op)) {
      throw new HttpException(`Unknown filter operator: ${f.op}`, 400);
    }
    return { column: f.column, op: f.op as FilterOperator, value: f.value != null ? String(f.value) : undefined };
  });
}

function fieldOrThrow(fields: FieldMeta[], column: string): FieldMeta {
  const field = fields.find(f => f.name === column);
  if (!field) throw new HttpException(`Unknown filter column: ${column}`, 400);
  return field;
}

function requireValue(filter: RowFilter): string {
  if (filter.value == null || filter.value === '') {
    throw new HttpException(`Filter "${filter.op}" on "${filter.column}" needs a value`, 400);
  }
  return filter.value;
}

/** Wrap a LIKE/ILIKE term with %…% when the user supplied no explicit wildcard. */
function likeTerm(value: string): string {
  return value.includes('%') || value.includes('_') ? value : `%${value}%`;
}

/**
 * Build a parameterised WHERE clause for raw-SQL (dynamic) tables.
 * Returns an empty clause and no params when there are no filters.
 */
export function buildRowFilterSql(
  filters: RowFilter[],
  fields: FieldMeta[],
): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const placeholder = () => `$${params.length + 1}`;

  for (const filter of filters) {
    const field = fieldOrThrow(fields, filter.column);
    const col = `"${field.name}"`;
    const category = categorize(field.type);

    switch (filter.op) {
      case 'is_null': conditions.push(`${col} IS NULL`); break;
      case 'not_null': conditions.push(`${col} IS NOT NULL`); break;
      case 'like':
      case 'ilike': {
        const keyword = filter.op === 'like' ? 'LIKE' : 'ILIKE';
        conditions.push(`${col}::text ${keyword} ${placeholder()}`);
        params.push(likeTerm(requireValue(filter)));
        break;
      }
      case 'in': {
        const items = requireValue(filter).split(',').map(s => s.trim()).filter(Boolean);
        if (!items.length) throw new HttpException(`Filter "in" on "${filter.column}" needs at least one value`, 400);
        const slots = items.map(item => { const slot = placeholder(); params.push(coerce(item, category, filter.column)); return slot; });
        conditions.push(`${col} IN (${slots.join(', ')})`);
        break;
      }
      default: {
        const sqlOp = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[filter.op];
        conditions.push(`${col} ${sqlOp} ${placeholder()}`);
        params.push(coerce(requireValue(filter), category, filter.column));
      }
    }
  }

  return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

/** Build a Prisma `where` object for schema-backed models. Returns undefined when empty. */
export function buildRowFilterPrismaWhere(
  filters: RowFilter[],
  fields: FieldMeta[],
): Record<string, unknown> | undefined {
  if (!filters.length) return undefined;
  const and: Record<string, unknown>[] = [];

  for (const filter of filters) {
    const field = fieldOrThrow(fields, filter.column);
    if (field.kind !== 'scalar') throw new HttpException(`Cannot filter on relation field "${filter.column}"`, 400);
    const category = categorize(field.type);

    switch (filter.op) {
      case 'is_null': and.push({ [field.name]: null }); break;
      case 'not_null': and.push({ [field.name]: { not: null } }); break;
      case 'eq': and.push({ [field.name]: coerce(requireValue(filter), category, filter.column) }); break;
      case 'neq': and.push({ [field.name]: { not: coerce(requireValue(filter), category, filter.column) } }); break;
      case 'gt': and.push({ [field.name]: { gt: coerce(requireValue(filter), category, filter.column) } }); break;
      case 'gte': and.push({ [field.name]: { gte: coerce(requireValue(filter), category, filter.column) } }); break;
      case 'lt': and.push({ [field.name]: { lt: coerce(requireValue(filter), category, filter.column) } }); break;
      case 'lte': and.push({ [field.name]: { lte: coerce(requireValue(filter), category, filter.column) } }); break;
      case 'like': and.push({ [field.name]: { contains: requireValue(filter).replace(/%/g, '') } }); break;
      case 'ilike': and.push({ [field.name]: { contains: requireValue(filter).replace(/%/g, ''), mode: 'insensitive' } }); break;
      case 'in': {
        const items = requireValue(filter).split(',').map(s => s.trim()).filter(Boolean);
        if (!items.length) throw new HttpException(`Filter "in" on "${filter.column}" needs at least one value`, 400);
        and.push({ [field.name]: { in: items.map(item => coerce(item, category, filter.column)) } });
        break;
      }
    }
  }

  return { AND: and };
}
