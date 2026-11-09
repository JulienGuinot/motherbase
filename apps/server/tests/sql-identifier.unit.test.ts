import { describe, expect, it } from 'vitest';
import { quoteIdentCatalog, quoteIdentStrict } from '../lib/sql-identifier';
import { assertSafeColumnType } from '../services/admin/schema-ddl';

describe('quoteIdentStrict', () => {
  it('quotes a plain identifier', () => {
    expect(quoteIdentStrict('user_id1')).toBe('"user_id1"');
  });

  it.each(['', '1abc', 'a-b', 'a b', 'a"b', 'a;drop table x', 'schema.table'])('rejects %j', name => {
    expect(() => quoteIdentStrict(name)).toThrow(/Invalid SQL identifier/);
  });

  it('rejects non-strings', () => {
    expect(() => quoteIdentStrict(undefined as unknown as string)).toThrow();
  });
});

describe('quoteIdentCatalog', () => {
  it('doubles embedded quotes instead of refusing', () => {
    expect(quoteIdentCatalog('my "odd" table')).toBe('"my ""odd"" table"');
  });
});

describe('assertSafeColumnType', () => {
  it.each(['text', 'varchar(255)', 'numeric(10,2)', 'text[]', 'reporting.mood', ' int4 '])('accepts %j', type => {
    expect(assertSafeColumnType(type)).toBe(type.trim());
  });

  it.each(['int; drop table x', "text'", 'text--', 'text/*x*/', '', 'int"'])('rejects %j', type => {
    expect(() => assertSafeColumnType(type)).toThrow(/Invalid column type/);
  });
});
