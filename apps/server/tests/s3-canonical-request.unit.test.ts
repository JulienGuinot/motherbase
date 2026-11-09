import { describe, expect, it } from 'vitest';
import { canonicalRequest, type SignatureClaim, type SignedRequest } from '../services/storage/s3-sigv4';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('canonicalRequest', () => {
  // Known answer: the GET Object example in the AWS "Signature Version 4 for
  // Amazon S3" docs, whose canonical request is spelled out there.
  it('matches the AWS documented GET Object example', () => {
    const req: SignedRequest = {
      method: 'GET',
      path: '/test.txt',
      query: new URLSearchParams(),
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        range: 'bytes=0-9',
        'x-amz-content-sha256': EMPTY_SHA256,
        'x-amz-date': '20130524T000000Z',
      },
    };
    const claim = {
      signedHeaders: ['host', 'range', 'x-amz-content-sha256', 'x-amz-date'],
      payloadHash: EMPTY_SHA256,
      presigned: false,
    } as SignatureClaim;

    expect(canonicalRequest(req, claim)).toBe(
      [
        'GET',
        '/test.txt',
        '',
        'host:examplebucket.s3.amazonaws.com',
        'range:bytes=0-9',
        `x-amz-content-sha256:${EMPTY_SHA256}`,
        'x-amz-date:20130524T000000Z',
        '',
        'host;range;x-amz-content-sha256;x-amz-date',
        EMPTY_SHA256,
      ].join('\n'),
    );
  });

  it('sorts and encodes the query, and drops X-Amz-Signature only when presigned', () => {
    const req: SignedRequest = {
      method: 'GET',
      path: '/b/a%20b',
      query: new URLSearchParams('prefix=a b&X-Amz-Signature=sig&acl='),
      headers: { host: 'h' },
    };
    const base = { signedHeaders: ['host'], payloadHash: 'UNSIGNED-PAYLOAD' };
    const presigned = canonicalRequest(req, { ...base, presigned: true } as SignatureClaim).split('\n');
    expect(presigned[1]).toBe('/b/a%20b');
    expect(presigned[2]).toBe('acl=&prefix=a%20b');
    expect(canonicalRequest(req, { ...base, presigned: false } as SignatureClaim).split('\n')[2]).toContain('X-Amz-Signature=sig');
  });
});
