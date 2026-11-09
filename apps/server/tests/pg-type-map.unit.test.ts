import { describe, expect, it } from 'vitest';
import { pgTypeToTsType } from '../services/rest-api/catalog';

// Phase 3.1: the Postgres -> TypeScript mapping is the foundation of type
// generation, so it is pinned exhaustively here rather than incidentally
// through the catalog integration test. Pure function, no database needed.

const base = (pgType: string) => pgTypeToTsType({ pgType, typeKind: 'b' });

describe('pgTypeToTsType: scalars', () => {
  it.each([
    // numeric family
    ['int2', 'number'],
    ['int4', 'number'],
    ['int8', 'number'],
    ['numeric', 'number'],
    ['float4', 'number'],
    ['float8', 'number'],
    ['oid', 'number'],
    // boolean
    ['bool', 'boolean'],
    // character family
    ['text', 'string'],
    ['varchar', 'string'],
    ['bpchar', 'string'],
    ['char', 'string'],
    ['name', 'string'],
    ['uuid', 'string'],
    ['citext', 'string'],
    ['xml', 'string'],
    // json
    ['json', 'Json'],
    ['jsonb', 'Json'],
    // date/time family: PostgREST renders every one of these as a string
    ['date', 'string'],
    ['time', 'string'],
    ['timetz', 'string'],
    ['timestamp', 'string'],
    ['timestamptz', 'string'],
    ['interval', 'string'],
    // binary and money arrive as their text renderings over JSON
    ['bytea', 'string'],
    ['money', 'string'],
    // deliberately unmapped: no honest TypeScript rendering exists
    ['point', 'unknown'],
    ['line', 'unknown'],
    ['polygon', 'unknown'],
    ['circle', 'unknown'],
    ['inet', 'unknown'],
    ['cidr', 'unknown'],
    ['macaddr', 'unknown'],
    ['tsvector', 'unknown'],
    ['tsquery', 'unknown'],
    ['int4range', 'unknown'],
    ['daterange', 'unknown'],
    ['pg_lsn', 'unknown'],
    ['bit', 'unknown'],
    ['varbit', 'unknown'],
  ])('maps %s to %s', (pgType, expected) => {
    expect(base(pgType)).toBe(expected);
  });

  it('never falls back to any', () => {
    // `unknown` forces a narrowing at the call site; `any` would silently
    // disable type checking for every column of an unmapped type.
    expect(base('some_extension_type')).toBe('unknown');
  });
});

describe('pgTypeToTsType: arrays', () => {
  it('wraps the element type', () => {
    expect(pgTypeToTsType({ pgType: '_int4', typeKind: 'b', elem: { pgType: 'int4', typeKind: 'b' } })).toBe(
      'number[]'
    );
    expect(pgTypeToTsType({ pgType: '_text', typeKind: 'b', elem: { pgType: 'text', typeKind: 'b' } })).toBe(
      'string[]'
    );
    expect(pgTypeToTsType({ pgType: '_jsonb', typeKind: 'b', elem: { pgType: 'jsonb', typeKind: 'b' } })).toBe(
      'Json[]'
    );
  });

  it('propagates unknown through the element type', () => {
    expect(pgTypeToTsType({ pgType: '_point', typeKind: 'b', elem: { pgType: 'point', typeKind: 'b' } })).toBe(
      'unknown[]'
    );
  });

  it('parenthesises a union element so the array binds to the whole union', () => {
    expect(
      pgTypeToTsType({
        pgType: '_mood',
        typeKind: 'b',
        elem: { pgType: 'mood', typeKind: 'e', enumValues: ['happy', 'sad'] },
      })
    ).toBe("('happy' | 'sad')[]");
  });

  it('nests recursively for an array of arrays', () => {
    expect(
      pgTypeToTsType({
        pgType: '_int4',
        typeKind: 'b',
        elem: { pgType: '_int4', typeKind: 'b', elem: { pgType: 'int4', typeKind: 'b' } },
      })
    ).toBe('number[][]');
  });
});

describe('pgTypeToTsType: enums', () => {
  it('renders a user enum as a union of its labels', () => {
    expect(pgTypeToTsType({ pgType: 'mood', typeKind: 'e', enumValues: ['happy', 'sad', 'neutral'] })).toBe(
      "'happy' | 'sad' | 'neutral'"
    );
  });

  it('escapes quotes and backslashes in labels', () => {
    expect(pgTypeToTsType({ pgType: 'weird', typeKind: 'e', enumValues: ["it's", 'a\\b'] })).toBe(
      "'it\\'s' | 'a\\\\b'"
    );
  });

  it('falls back to string when the labels are unknown', () => {
    expect(pgTypeToTsType({ pgType: 'mood', typeKind: 'e' })).toBe('string');
  });
});

describe('pgTypeToTsType: domains and composites', () => {
  it('resolves a domain to its base type', () => {
    expect(
      pgTypeToTsType({ pgType: 'positive', typeKind: 'd', base: { pgType: 'int4', typeKind: 'b' } })
    ).toBe('number');
  });

  it('resolves a domain over an enum, and a domain over an array', () => {
    expect(
      pgTypeToTsType({
        pgType: 'mood_domain',
        typeKind: 'd',
        base: { pgType: 'mood', typeKind: 'e', enumValues: ['a', 'b'] },
      })
    ).toBe("'a' | 'b'");
    expect(
      pgTypeToTsType({
        pgType: 'tags_domain',
        typeKind: 'd',
        base: { pgType: '_text', typeKind: 'b', elem: { pgType: 'text', typeKind: 'b' } },
      })
    ).toBe('string[]');
  });

  it('maps a domain with no resolved base to unknown', () => {
    expect(pgTypeToTsType({ pgType: 'mystery', typeKind: 'd' })).toBe('unknown');
  });

  it('renders a composite type as an object when its attributes are known', () => {
    expect(
      pgTypeToTsType({
        pgType: 'addr',
        typeKind: 'c',
        attributes: [
          { name: 'street', tsType: 'string', nullable: false },
          { name: 'zip', tsType: 'number', nullable: true },
        ],
      })
    ).toBe('{ street: string; zip: number | null }');
  });

  it('maps a composite with unresolved attributes to unknown rather than guessing', () => {
    expect(pgTypeToTsType({ pgType: 'addr', typeKind: 'c' })).toBe('unknown');
  });
});
