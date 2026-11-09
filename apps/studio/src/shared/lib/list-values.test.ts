import { describe, it, expect } from 'vitest';
import {
  addToList,
  functionNameError,
  joinList,
  mimeTypeError,
  originError,
  phoneCodePairError,
  splitList,
} from './list-values';

describe('splitList', () => {
  it('splits on commas, spaces and newlines, dropping blanks', () => {
    expect(splitList(' a.com,b.com  c.com\n\nd.com, ')).toEqual(['a.com', 'b.com', 'c.com', 'd.com']);
  });

  it('reads the stored form back', () => {
    expect(splitList(joinList(['https://a.dev', '*']))).toEqual(['https://a.dev', '*']);
    expect(splitList('')).toEqual([]);
  });
});

describe('addToList', () => {
  it('appends new items once, keeping order', () => {
    expect(addToList(['a'], ['b', 'a', 'b', '', 'c'])).toEqual(['a', 'b', 'c']);
  });
});

describe('originError', () => {
  it('accepts a bare origin, with or without a trailing slash', () => {
    expect(originError('https://app.example.com')).toBeNull();
    expect(originError('http://localhost:3000/')).toBeNull();
  });

  it('rejects paths, other schemes and non-URLs', () => {
    expect(originError('https://app.example.com/login')).not.toBeNull();
    expect(originError('ftp://example.com')).not.toBeNull();
    expect(originError('app.example.com')).not.toBeNull();
  });

  it('accepts * only where the wildcard is allowed', () => {
    expect(originError('*')).not.toBeNull();
    expect(originError('*', { allowWildcard: true })).toBeNull();
  });
});

describe('phoneCodePairError', () => {
  it('accepts phone:code and rejects anything else', () => {
    expect(phoneCodePairError('+15550001111:123456')).toBeNull();
    expect(phoneCodePairError('+15550001111')).not.toBeNull();
    expect(phoneCodePairError('abc:123456')).not.toBeNull();
  });
});

describe('functionNameError', () => {
  it('accepts quoted-identifier names verbatim: a typo lands as a 403, not here', () => {
    expect(functionNameError('rpc_search')).toBeNull();
    expect(functionNameError('MyFn')).toBeNull();
    expect(functionNameError('ns.fn()')).toBeNull();
  });

  it('rejects what could never be a function name', () => {
    expect(functionNameError('bad\tname')).not.toBeNull();
    // 63 bytes UTF-8 (one 2-byte accent + 62 ASCII) is the exact server-side limit.
    expect(functionNameError('é' + 'a'.repeat(61))).toBeNull();
    expect(functionNameError('é' + 'a'.repeat(62))).not.toBeNull();
  });
});

describe('mimeTypeError', () => {
  it('accepts type/subtype and wildcards on either side', () => {
    expect(mimeTypeError('image/png')).toBeNull();
    expect(mimeTypeError('image/*')).toBeNull();
    expect(mimeTypeError('*/*')).toBeNull();
    expect(mimeTypeError('application/vnd.api+json')).toBeNull();
  });

  it('rejects anything that is not type/subtype', () => {
    expect(mimeTypeError('image')).not.toBeNull();
    expect(mimeTypeError('image/')).not.toBeNull();
    expect(mimeTypeError('/png')).not.toBeNull();
    expect(mimeTypeError('image/png;charset=utf-8')).not.toBeNull();
  });
});
