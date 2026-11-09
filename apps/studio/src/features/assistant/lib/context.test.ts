import { describe, expect, it } from 'vitest';
import { pageContextFrom } from './context';

describe('pageContextFrom', () => {
  it('reads the project id out of a project-scoped path', () => {
    expect(pageContextFrom('/p/demo/database/tables', {})).toMatchObject({
      project: 'demo',
      route: '/database/tables',
    });
  });

  it('keeps the raw path when the mount is per project', () => {
    expect(pageContextFrom('/sql', { project: 'demo' })).toMatchObject({
      project: 'demo',
      route: '/sql',
    });
  });

  it('carries the schema, table and selection through', () => {
    expect(
      pageContextFrom('/p/demo/sql', { schema: 'auth', table: 'users', selection: 'select 1' }),
    ).toMatchObject({ schema: 'auth', table: 'users', selection: 'select 1' });
  });
});
