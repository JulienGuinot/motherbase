import { describe, it, expect } from 'vitest';
import { buildAddColumnSql, type ColumnDef } from '../services/admin/schema.service';

const base: ColumnDef = { name: 'title', type: 'text', nullable: true, default: null };

describe('buildAddColumnSql', () => {
  it('builds a minimal nullable column', () => {
    const { sql, comment } = buildAddColumnSql('todo', base, 'public');
    expect(sql).toBe('ALTER TABLE "public"."todo" ADD COLUMN "title" text');
    expect(comment).toBeUndefined();
  });

  it('applies NOT NULL, UNIQUE, PK and DEFAULT in order', () => {
    const { sql } = buildAddColumnSql('todo', {
      ...base, name: 'id', type: 'uuid', nullable: false, unique: true, isPrimaryKey: true, default: 'gen_random_uuid()',
    }, 'public');
    expect(sql).toBe('ALTER TABLE "public"."todo" ADD COLUMN "id" uuid PRIMARY KEY UNIQUE NOT NULL DEFAULT gen_random_uuid()');
  });

  it('emits a REFERENCES clause with ON DELETE', () => {
    const { sql } = buildAddColumnSql('todo', {
      ...base, name: 'user_id', type: 'uuid', references: { table: 'users', column: 'id', onDelete: 'CASCADE' },
    }, 'public');
    expect(sql).toContain('REFERENCES "public"."users" ("id") ON DELETE CASCADE');
  });

  it('emits a CHECK clause', () => {
    const { sql } = buildAddColumnSql('todo', { ...base, name: 'age', type: 'integer', check: 'age >= 0' }, 'public');
    expect(sql).toContain('CHECK (age >= 0)');
  });

  it('returns a parameter-bound COMMENT statement', () => {
    const { comment } = buildAddColumnSql('todo', { ...base, comment: 'the title; drop table x' }, 'public');
    expect(comment?.sql).toBe('COMMENT ON COLUMN "public"."todo"."title" IS $1');
    expect(comment?.param).toBe('the title; drop table x');
  });

  it('rejects an invalid identifier', () => {
    expect(() => buildAddColumnSql('todo', { ...base, name: 'bad name' }, 'public')).toThrow(/identifier/);
  });

  it('rejects an unsafe column type', () => {
    expect(() => buildAddColumnSql('todo', { ...base, type: 'text); DROP TABLE x;--' }, 'public')).toThrow(/column type/);
  });

  it('rejects a CHECK expression containing a statement separator', () => {
    expect(() => buildAddColumnSql('todo', { ...base, check: 'true); DROP TABLE x;--' }, 'public')).toThrow(/statements are not allowed/);
  });

  it('rejects an invalid ON DELETE action', () => {
    expect(() => buildAddColumnSql('todo', {
      ...base, references: { table: 'users', column: 'id', onDelete: 'BOOM' as any },
    }, 'public')).toThrow(/ON DELETE/);
  });
});
