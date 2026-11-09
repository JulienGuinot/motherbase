import { describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'crypto';
import { Readable } from 'stream';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  AwsChunkedDecoder,
  parseSignatureClaim,
  payloadMode,
  payloadVerifier,
  verifySignature,
  type SignedRequest,
} from '../services/storage/s3-sigv4';
import { xmlBlocks, xmlDocument, xmlText } from '../services/storage/s3-xml';

const credentials = { accessKeyId: 'a'.repeat(32), secretAccessKey: 'b'.repeat(64) };

/** Sign with the real AWS SDK, then verify with ours: the only oracle that matters. */
async function presigned(key: string): Promise<SignedRequest> {
  const client = new S3Client({ region: 'us-east-1', endpoint: 'http://localhost:5001/storage/v1/s3', forcePathStyle: true, credentials });
  const url = new URL(await getSignedUrl(client, new GetObjectCommand({ Bucket: 'avatars', Key: key }), { expiresIn: 60 }));
  return { method: 'GET', path: url.pathname, query: url.searchParams, headers: { host: url.host } };
}

async function collect(stream: Readable): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += chunk.toString();
  return out;
}

describe('SigV4 verification', () => {
  it('accepts a URL presigned by the AWS SDK, including awkward keys', async () => {
    for (const key of ['u1/me.png', 'dir with space/ünïcode (1)!*.txt']) {
      const req = await presigned(key);
      const claim = parseSignatureClaim(req)!;
      expect(claim).toMatchObject({ accessKeyId: credentials.accessKeyId, region: 'us-east-1', presigned: true });
      expect(() => verifySignature(req, claim, credentials.secretAccessKey)).not.toThrow();
    }
  });

  it('refuses a wrong secret, a tampered path and an expired URL', async () => {
    const req = await presigned('u1/me.png');
    const claim = parseSignatureClaim(req)!;
    expect(() => verifySignature(req, claim, 'c'.repeat(64))).toThrow(/does not match/);
    expect(() => verifySignature({ ...req, path: req.path.replace('me.png', 'you.png') }, claim, credentials.secretAccessKey)).toThrow(/does not match/);
    expect(() => verifySignature(req, claim, credentials.secretAccessKey, Date.now() + 120_000)).toThrow(/expired/);
  });

  it('knows the payload modes the SDKs send', () => {
    expect(payloadMode('UNSIGNED-PAYLOAD')).toBe('unsigned');
    expect(payloadMode('STREAMING-UNSIGNED-PAYLOAD-TRAILER')).toBe('aws-chunked-unsigned');
    expect(payloadMode('STREAMING-AWS4-HMAC-SHA256-PAYLOAD')).toBe('aws-chunked-signed');
    expect(payloadMode('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBe('sha256');
    expect(() => payloadMode('whatever')).toThrow();
  });
});

describe('payload integrity', () => {
  it('fails the stream when the body does not hash to the signed value', async () => {
    const good = createHash('sha256').update('hello').digest('hex');
    await expect(collect(Readable.from([Buffer.from('hello')]).pipe(payloadVerifier(good)))).resolves.toBe('hello');
    await expect(collect(Readable.from([Buffer.from('hellx')]).pipe(payloadVerifier(good)))).rejects.toThrow(/does not match/);
  });

  it('decodes aws-chunked framing, split at any byte, and ignores the trailer', async () => {
    const body = Buffer.from('5\r\nhello\r\n6\r\n world\r\n0\r\nx-amz-checksum-crc32:abc=\r\n\r\n');
    const pieces = [...body].map(byte => Buffer.from([byte]));
    await expect(collect(Readable.from(pieces).pipe(new AwsChunkedDecoder()))).resolves.toBe('hello world');
  });

  it('verifies chunk signatures as a chain from the seed', async () => {
    const key = Buffer.alloc(32, 1);
    const signing = { key, date: '20260928T000000Z', scope: '20260928/us-east-1/s3/aws4_request', seedSignature: 'seed' };
    const empty = createHash('sha256').update('').digest('hex');
    const sign = (previous: string, data: string) => createHmac('sha256', key).update([
      'AWS4-HMAC-SHA256-PAYLOAD', signing.date, signing.scope, previous, empty, createHash('sha256').update(data).digest('hex'),
    ].join('\n')).digest('hex');
    const first = sign('seed', 'hello');
    const last = sign(first, '');
    const framed = `5;chunk-signature=${first}\r\nhello\r\n0;chunk-signature=${last}\r\n\r\n`;
    await expect(collect(Readable.from([Buffer.from(framed)]).pipe(new AwsChunkedDecoder(signing)))).resolves.toBe('hello');
    const forged = framed.replace('hello', 'jello');
    await expect(collect(Readable.from([Buffer.from(forged)]).pipe(new AwsChunkedDecoder(signing)))).rejects.toThrow(/signature/);
  });
});

describe('S3 XML', () => {
  it('escapes on the way out and unescapes on the way in', () => {
    const doc = xmlDocument('ListBucketResult', { Name: 'b', Contents: [{ Key: 'a&b<c>' }, { Key: 'd' }] });
    expect(doc).toContain('<Key>a&amp;b&lt;c&gt;</Key><Key>d</Key>'.replace('</Key><Key>', '</Key></Contents><Contents><Key>'));
    const request = '<Delete><Object><Key>a&amp;b</Key></Object><Object><Key> spaced </Key></Object></Delete>';
    expect(xmlBlocks(request, 'Object').map(block => xmlText(block, 'Key'))).toEqual(['a&b', ' spaced ']);
  });
});
