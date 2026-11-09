import { describe, expect, it } from 'vitest';
import { importSchemaSql, optionsClause, parseOptions } from '../services/admin/wrapper.service';

describe('wrapper SQL', () => {
  it('quotes option values and refuses option names that are not plain words', () => {
    expect(optionsClause({ host: "db'; DROP", port: '5432', empty: '' })).toBe(
      " OPTIONS (host 'db''; DROP', port '5432')",
    );
    expect(optionsClause({ user: 'u' }, 'SET')).toBe(" OPTIONS (SET user 'u')");
    expect(optionsClause({})).toBe('');
    expect(() => optionsClause({ 'host) ; --': 'x' })).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('reads catalog options back into an object, keeping = inside values', () => {
    expect(parseOptions(['host=db', 'options=-c search_path=a'])).toEqual({ host: 'db', options: '-c search_path=a' });
    expect(parseOptions(null)).toEqual({});
  });

  it('limits an import only when tables are named', () => {
    expect(importSchemaSql('srv', { remoteSchema: 'public', localSchema: 'remote' })).toBe(
      'IMPORT FOREIGN SCHEMA "public" FROM SERVER "srv" INTO "remote"',
    );
    expect(importSchemaSql('srv', { remoteSchema: 'public', localSchema: 'remote', tables: ['a', 'b'] })).toBe(
      'IMPORT FOREIGN SCHEMA "public" LIMIT TO ("a", "b") FROM SERVER "srv" INTO "remote"',
    );
  });
});
