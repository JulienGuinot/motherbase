import { describe, it, expect } from 'vitest';
import {
  parseRowFilters,
  buildRowFilterSql,
  buildRowFilterPrismaWhere,
} from '../services/admin/row-filters';
import type { FieldMeta } from '../services/admin/admin.service';

const field = (name: string, type: string, kind: FieldMeta['kind'] = 'scalar'): FieldMeta => ({
  name, type, kind, isId: false, isList: false, isRequired: false, isReadOnly: false, sensitive: false,
});

const FIELDS: FieldMeta[] = [
  field('id', 'uuid'),
  field('email', 'text'),
  field('age', 'integer'),
  field('active', 'boolean'),
  field('author', 'User', 'object'),
];

describe('parseRowFilters', () => {
  it('returns [] for empty input', () => {
    expect(parseRowFilters(undefined)).toEqual([]);
    expect(parseRowFilters('')).toEqual([]);
  });

  it('parses a JSON array', () => {
    const out = parseRowFilters(JSON.stringify([{ column: 'email', op: 'eq', value: 'a@b.c' }]));
    expect(out).toEqual([{ column: 'email', op: 'eq', value: 'a@b.c' }]);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseRowFilters('{not json')).toThrow(/JSON/);
  });

  it('rejects unknown operators', () => {
    expect(() => parseRowFilters(JSON.stringify([{ column: 'x', op: 'drop' }]))).toThrow(/operator/);
  });
});

describe('buildRowFilterSql', () => {
  it('is empty with no filters', () => {
    expect(buildRowFilterSql([], FIELDS)).toEqual({ clause: '', params: [] });
  });

  it('parameterises equality and coerces numeric values', () => {
    const { clause, params } = buildRowFilterSql([{ column: 'age', op: 'gte', value: '18' }], FIELDS);
    expect(clause).toBe('WHERE "age" >= $1');
    expect(params).toEqual([18]);
  });

  it('never interpolates the value into the SQL text', () => {
    const { clause, params } = buildRowFilterSql(
      [{ column: 'email', op: 'eq', value: "x'; DROP TABLE users;--" }],
      FIELDS,
    );
    expect(clause).toBe('WHERE "email" = $1');
    expect(params).toEqual(["x'; DROP TABLE users;--"]);
  });

  it('wraps LIKE terms with wildcards and casts to text', () => {
    const { clause, params } = buildRowFilterSql([{ column: 'email', op: 'ilike', value: 'acme' }], FIELDS);
    expect(clause).toBe('WHERE "email"::text ILIKE $1');
    expect(params).toEqual(['%acme%']);
  });

  it('handles IS NULL without a param', () => {
    const { clause, params } = buildRowFilterSql([{ column: 'age', op: 'is_null' }], FIELDS);
    expect(clause).toBe('WHERE "age" IS NULL');
    expect(params).toEqual([]);
  });

  it('expands IN into one placeholder per value', () => {
    const { clause, params } = buildRowFilterSql([{ column: 'age', op: 'in', value: '1, 2 ,3' }], FIELDS);
    expect(clause).toBe('WHERE "age" IN ($1, $2, $3)');
    expect(params).toEqual([1, 2, 3]);
  });

  it('combines multiple filters with AND and increments placeholders', () => {
    const { clause, params } = buildRowFilterSql(
      [{ column: 'active', op: 'eq', value: 'true' }, { column: 'age', op: 'lt', value: '30' }],
      FIELDS,
    );
    expect(clause).toBe('WHERE "active" = $1 AND "age" < $2');
    expect(params).toEqual([true, 30]);
  });

  it('rejects an unknown column', () => {
    expect(() => buildRowFilterSql([{ column: 'nope', op: 'eq', value: '1' }], FIELDS)).toThrow(/Unknown filter column/);
  });

  it('rejects a non-numeric value on a numeric column', () => {
    expect(() => buildRowFilterSql([{ column: 'age', op: 'eq', value: 'abc' }], FIELDS)).toThrow(/expects a number/);
  });
});

describe('buildRowFilterPrismaWhere', () => {
  it('returns undefined with no filters', () => {
    expect(buildRowFilterPrismaWhere([], FIELDS)).toBeUndefined();
  });

  it('builds an AND of scalar conditions', () => {
    const where = buildRowFilterPrismaWhere(
      [{ column: 'email', op: 'ilike', value: 'acme' }, { column: 'age', op: 'gt', value: '5' }],
      FIELDS,
    );
    expect(where).toEqual({ AND: [{ email: { contains: 'acme', mode: 'insensitive' } }, { age: { gt: 5 } }] });
  });

  it('refuses to filter on a relation field', () => {
    expect(() => buildRowFilterPrismaWhere([{ column: 'author', op: 'eq', value: 'x' }], FIELDS)).toThrow(/relation/);
  });
});
