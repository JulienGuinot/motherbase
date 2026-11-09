import { describe, expect, it } from 'vitest';
import { bucketCorsSchema } from '../services/storage/bucket-cors';

const valid = { allowedOrigins: ['https://app.example.com'], allowedMethods: ['GET'], allowedHeaders: ['content-type'] };

describe('bucketCorsSchema', () => {
  it('accepts a valid config and defaults maxAgeSec', () => {
    expect(bucketCorsSchema.parse(valid).maxAgeSec).toBe(3600);
    expect(bucketCorsSchema.safeParse({ ...valid, allowedOrigins: ['*'] }).success).toBe(true);
  });

  it.each([
    ['origin with a path', { allowedOrigins: ['https://a.example.com/x'] }],
    ['non-http origin', { allowedOrigins: ['ftp://a.example.com'] }],
    ['unknown method', { allowedMethods: ['TRACE'] }],
    ['no methods', { allowedMethods: [] }],
    ['bad header name', { allowedHeaders: ['x bad'] }],
    ['maxAge over a day', { maxAgeSec: 86401 }],
  ])('rejects %s', (_label, patch) => {
    expect(bucketCorsSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
