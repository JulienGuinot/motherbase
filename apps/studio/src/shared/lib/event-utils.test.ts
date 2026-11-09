import { describe, it, expect } from 'vitest';
import { isUserEventTable, eventModelName, formatEventSpec } from './event-utils';

describe('isUserEventTable', () => {
  it('keeps tables in the public schema', () => {
    expect(isUserEventTable({ model: 'todos', dbName: 'todos', schema: 'public' })).toBe(true);
  });

  it('drops every schema Motherbase owns', () => {
    for (const [model, schema] of [
      ['User', 'auth'],
      ['Session', 'auth'],
      ['Account', 'auth'],
      ['Passkey', 'auth'],
      ['ApiKey', 'auth'],
      ['File', 'storage'],
      ['BucketDeletionJob', 'storage'],
      ['AppSetting', 'platform'],
      ['RealtimeOutbox', 'platform'],
      ['SchemaMigration', 'platform'],
    ] as const) {
      expect(isUserEventTable({ model, schema }), model).toBe(false);
    }
  });

  it('drops Prisma and Postgres internals whatever the schema says', () => {
    expect(isUserEventTable({ model: '_prisma_migrations', dbName: '_prisma_migrations', schema: 'public' })).toBe(false);
    expect(isUserEventTable({ model: 'pg_stat_statements', dbName: 'pg_stat_statements', schema: 'public' })).toBe(false);
  });

  it('treats a missing schema as an app table', () => {
    expect(isUserEventTable({ model: 'legacy_table' })).toBe(true);
  });
});

describe('formatEventSpec', () => {
  const tables = [{ model: 'todos', dbName: 'todos', schema: 'public' }];

  it('describes the catch-all spec', () => {
    expect(formatEventSpec('*', tables)).toBe('All tables / all operations');
  });

  it('resolves a model name back to its display casing', () => {
    expect(formatEventSpec('todos.created', tables)).toContain('todos');
  });
});

describe('eventModelName', () => {
  it('lowercases the model, matching the server event name', () => {
    expect(eventModelName('Todos')).toBe('todos');
  });
});
