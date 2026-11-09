import { describe, expect, it } from 'vitest';
import {
  contentRange,
  negotiate,
  parsePrefer,
  parseRange,
  toCsv,
  toSingleObject,
  wantsPlan,
} from '../services/rest-api/http-semantics';

/**
 * The header half of the PostgREST dialect.
 *
 * These are pure functions, so they are tested without a database. The rules
 * they encode are the ones a client silently depends on: a misparsed `Prefer`
 * would turn an upsert into an insert, and a wrong `Content-Range` would make a
 * paginating client stop early or loop forever.
 */

describe('parsePrefer', () => {
  it('defaults to minimal, no count and no resolution', () => {
    expect(parsePrefer(undefined)).toEqual({
      count: null,
      return: 'minimal',
      resolution: null,
      singleObjectParams: false,
      maxAffected: null,
      txRollback: false,
    });
  });

  it('reads every preference from one comma separated header', () => {
    expect(parsePrefer('return=minimal, count=exact, resolution=merge-duplicates')).toMatchObject({
      return: 'minimal',
      count: 'exact',
      resolution: 'merge-duplicates',
    });
  });

  it('reads preferences spread across repeated header lines', () => {
    expect(parsePrefer(['count=planned', 'return=headers-only'])).toMatchObject({
      count: 'planned',
      return: 'headers-only',
    });
  });

  it('accepts params=single-object', () => {
    expect(parsePrefer('params=single-object').singleObjectParams).toBe(true);
  });

  it('ignores a preference it does not implement', () => {
    expect(() => parsePrefer('handling=lenient, tx=commit')).not.toThrow();
  });

  it('rejects an unknown value for a preference it does implement', () => {
    // Silently ignoring this would answer with no count while the caller waits
    // for one, which looks like a server bug rather than a client typo.
    expect(() => parsePrefer('count=aproximate')).toThrow(/count=aproximate/);
    expect(() => parsePrefer('return=everything')).toThrow();
    expect(() => parsePrefer('resolution=overwrite')).toThrow();
  });

  it('is case insensitive and tolerates quoting', () => {
    expect(parsePrefer('Return="Minimal"').return).toBe('minimal');
  });
});

describe('parsePrefer: the write budget', () => {
  it('reads max-affected as a row count', () => {
    expect(parsePrefer('handling=strict,max-affected=1').maxAffected).toBe(1);
    expect(parsePrefer('max-affected=0').maxAffected).toBe(0);
  });

  it('rejects a max-affected that is not a row count, rather than ignoring it', () => {
    // Ignoring it would answer 200 to a caller who asked to be protected.
    expect(() => parsePrefer('max-affected=many')).toThrow(/max-affected/);
    expect(() => parsePrefer('max-affected=-1')).toThrow(/max-affected/);
    expect(() => parsePrefer('max-affected=1.5')).toThrow(/max-affected/);
  });

  it('reads tx=rollback, and treats tx=commit as the default', () => {
    expect(parsePrefer('tx=rollback').txRollback).toBe(true);
    expect(parsePrefer('tx=commit').txRollback).toBe(false);
    expect(() => parsePrefer('tx=maybe')).toThrow(/tx=/);
  });
});

describe('parseRange', () => {
  it('reads an inclusive row range', () => {
    expect(parseRange('0-9')).toEqual({ offset: 0, limit: 10 });
    expect(parseRange('items=5-9')).toEqual({ offset: 5, limit: 5 });
  });

  it('reads an open-ended range as an offset with no limit', () => {
    expect(parseRange('7-')).toEqual({ offset: 7 });
  });

  it('ignores a header it cannot read, rather than guessing', () => {
    expect(parseRange('bytes=0-100')).toBeNull();
    expect(parseRange(undefined)).toBeNull();
  });

  it('rejects an inverted range', () => {
    expect(() => parseRange('9-0')).toThrow();
  });
});

describe('contentRange', () => {
  it('reports the served window and the total', () => {
    expect(contentRange(0, 10, 57)).toBe('0-9/57');
    expect(contentRange(20, 10, 57)).toBe('20-29/57');
  });

  it('leaves the total unknown when no count was requested', () => {
    expect(contentRange(0, 10, null)).toBe('0-9/*');
  });

  it('uses the empty form when nothing was returned', () => {
    expect(contentRange(0, 0, 0)).toBe('*/0');
    expect(contentRange(0, 0, null)).toBe('*/*');
  });
});

describe('negotiate', () => {
  it('defaults to json', () => {
    expect(negotiate(undefined)).toBe('json');
    expect(negotiate('application/json')).toBe('json');
    expect(negotiate('application/xml')).toBe('json');
  });

  it('selects csv and the single-object type', () => {
    expect(negotiate('text/csv')).toBe('csv');
    expect(negotiate('application/vnd.pgrst.object+json')).toBe('single-object');
  });

  it('detects the plan media type separately', () => {
    expect(wantsPlan('application/vnd.pgrst.plan')).toBe(true);
    expect(wantsPlan('application/json')).toBe(false);
  });
});

describe('toSingleObject', () => {
  it('unwraps exactly one row', () => {
    expect(toSingleObject([{ id: 'a' }])).toEqual({ id: 'a' });
  });

  it('answers 406 for zero or several rows, not 404', () => {
    // The failure is that the requested representation cannot be produced, which
    // is a negotiation failure and not a missing resource.
    expect(() => toSingleObject([])).toThrowError(expect.objectContaining({ statusCode: 406 }));
    expect(() => toSingleObject([{ id: 'a' }, { id: 'b' }])).toThrowError(
      expect.objectContaining({ statusCode: 406, code: 'PGRST116' }),
    );
  });
});

describe('toCsv', () => {
  it('writes a header row followed by the values', () => {
    expect(toCsv([{ id: 'a', qty: 1 }, { id: 'b', qty: 2 }])).toBe('id,qty\na,1\nb,2');
  });

  it('takes the union of the keys, in first-seen order', () => {
    expect(toCsv([{ a: 1 }, { b: 2 }])).toBe('a,b\n1,\n,2');
  });

  it('quotes a field containing a comma, a quote or a newline', () => {
    expect(toCsv([{ v: 'a,b' }])).toBe('v\n"a,b"');
    expect(toCsv([{ v: 'say "hi"' }])).toBe('v\n"say ""hi"""');
    expect(toCsv([{ v: 'one\ntwo' }])).toBe('v\n"one\ntwo"');
  });

  it('renders null as an empty field and json as its text', () => {
    expect(toCsv([{ a: null, b: { x: 1 } }])).toBe('a,b\n,"{""x"":1}"');
  });

  it('returns an empty document for no rows', () => {
    expect(toCsv([])).toBe('');
  });
});
