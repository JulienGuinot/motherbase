import { createHash, createHmac } from 'crypto';
import { Transform, type TransformCallback } from 'stream';
import { safeEqual } from '../../lib/safe-equal';

/**
 * AWS Signature Version 4, server side: enough to authenticate what the AWS
 * SDKs, the AWS CLI, rclone and friends send to an S3 endpoint.
 *
 * Two request shapes carry a signature: an `Authorization` header, and a
 * presigned URL (`X-Amz-Signature` in the query). Both reduce to the same
 * canonical request, so both are verified by `verifySignature`. Bodies are
 * covered either by a SHA-256 in `x-amz-content-sha256` (checked while the body
 * streams, see `payloadVerifier`) or by aws-chunked framing with a signature
 * per chunk (see `AwsChunkedDecoder`).
 *
 * Reference: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html
 */

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const STREAMING_SIGNED = 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD';
const STREAMING_SIGNED_TRAILER = 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER';
const STREAMING_UNSIGNED_TRAILER = 'STREAMING-UNSIGNED-PAYLOAD-TRAILER';
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
/** How far a request's clock may drift from ours, as AWS allows. */
const MAX_SKEW_MS = 15 * 60 * 1000;
const MAX_PRESIGN_SECONDS = 604800;

export class SigV4Error extends Error {
  constructor(readonly code: 'AccessDenied' | 'SignatureDoesNotMatch' | 'InvalidAccessKeyId' | 'RequestTimeTooSkewed' | 'AuthorizationHeaderMalformed' | 'XAmzContentSHA256Mismatch', message: string) {
    super(message);
  }
}

export interface SignedRequest {
  method: string;
  /** Path as received, still percent-encoded, without the query string. */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
}

/** What a request claims about its signature, before it is checked. */
export interface SignatureClaim {
  accessKeyId: string;
  /** `YYYYMMDD/region/s3/aws4_request`. */
  scope: string;
  date: string;
  region: string;
  signedHeaders: string[];
  signature: string;
  /** The payload hash the signature covers. */
  payloadHash: string;
  presigned: boolean;
  expiresInSec?: number;
}

const header = (req: SignedRequest, name: string): string => {
  const value = req.headers[name];
  return (Array.isArray(value) ? value.join(',') : value ?? '').trim();
};

/** RFC 3986 encoding, the way SigV4 wants it: everything but unreserved characters. */
export function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function parseCredential(credential: string) {
  const [accessKeyId, date, region, service, terminator] = credential.split('/');
  if (!accessKeyId || !/^\d{8}$/.test(date ?? '') || !region || service !== 's3' || terminator !== 'aws4_request') {
    throw new SigV4Error('AuthorizationHeaderMalformed', 'The credential scope is malformed');
  }
  return { accessKeyId, region, scope: `${date}/${region}/s3/aws4_request` };
}

/** Read the claim out of the Authorization header or the presign query. */
export function parseSignatureClaim(req: SignedRequest): SignatureClaim | null {
  const authorization = header(req, 'authorization');
  if (authorization.startsWith('AWS4-HMAC-SHA256 ')) {
    const fields = Object.fromEntries(
      authorization.slice('AWS4-HMAC-SHA256 '.length).split(',').map(part => {
        const [key, ...value] = part.trim().split('=');
        return [key, value.join('=')];
      }),
    );
    if (!fields.Credential || !fields.SignedHeaders || !fields.Signature) {
      throw new SigV4Error('AuthorizationHeaderMalformed', 'The authorization header is malformed');
    }
    return {
      ...parseCredential(fields.Credential),
      date: header(req, 'x-amz-date'),
      signedHeaders: fields.SignedHeaders.split(';'),
      signature: fields.Signature,
      payloadHash: header(req, 'x-amz-content-sha256') || EMPTY_SHA256,
      presigned: false,
    };
  }
  if (req.query.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256') {
    const expires = Number(req.query.get('X-Amz-Expires'));
    if (!Number.isInteger(expires) || expires < 1 || expires > MAX_PRESIGN_SECONDS) {
      throw new SigV4Error('AuthorizationHeaderMalformed', 'X-Amz-Expires must be between 1 and 604800 seconds');
    }
    return {
      ...parseCredential(req.query.get('X-Amz-Credential') ?? ''),
      date: req.query.get('X-Amz-Date') ?? '',
      signedHeaders: (req.query.get('X-Amz-SignedHeaders') ?? '').split(';'),
      signature: req.query.get('X-Amz-Signature') ?? '',
      payloadHash: UNSIGNED_PAYLOAD,
      presigned: true,
      expiresInSec: expires,
    };
  }
  return null;
}

/** `20260928T101500Z` as epoch milliseconds, or NaN. */
function amzDate(value: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

export function canonicalRequest(req: SignedRequest, claim: SignatureClaim): string {
  // Each path segment is decoded and re-encoded, so a client that encodes a
  // little more or less than AWS does (`!`, `*`, `~`) still canonicalises to
  // the same string it signed.
  const path = req.path.split('/').map(segment => awsEncode(decodeURIComponent(segment))).join('/') || '/';
  const query = [...req.query.entries()]
    .filter(([key]) => !(claim.presigned && key === 'X-Amz-Signature'))
    .map(([key, value]) => [awsEncode(key), awsEncode(value)])
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const headers = claim.signedHeaders
    .map(name => `${name}:${header(req, name).replace(/\s+/g, ' ')}\n`)
    .join('');
  return [req.method, path, query, headers, claim.signedHeaders.join(';'), claim.payloadHash].join('\n');
}

function signingKey(secret: string, scope: string): Buffer {
  const [date, region] = scope.split('/');
  const kDate = createHmac('sha256', `AWS4${secret}`).update(date).digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update('s3').digest();
  return createHmac('sha256', kService).update('aws4_request').digest();
}

const hmacHex = (key: Buffer, value: string) => createHmac('sha256', key).update(value).digest('hex');
const sha256Hex = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/**
 * Verify the claim against the secret. Returns the signing key, which a
 * streaming-signed body needs to check each of its chunks.
 */
export function verifySignature(req: SignedRequest, claim: SignatureClaim, secret: string, now = Date.now()): Buffer {
  const signedAt = amzDate(claim.date);
  if (Number.isNaN(signedAt)) throw new SigV4Error('AccessDenied', 'X-Amz-Date is missing or malformed');
  if (!claim.signedHeaders.includes('host')) throw new SigV4Error('AccessDenied', 'The host header must be signed');
  if (claim.presigned) {
    if (now > signedAt + (claim.expiresInSec ?? 0) * 1000) throw new SigV4Error('AccessDenied', 'Request has expired');
    if (signedAt - now > MAX_SKEW_MS) throw new SigV4Error('RequestTimeTooSkewed', 'The request is signed in the future');
  } else if (Math.abs(now - signedAt) > MAX_SKEW_MS) {
    throw new SigV4Error('RequestTimeTooSkewed', 'The difference between the request time and the server time is too large');
  }
  const stringToSign = ['AWS4-HMAC-SHA256', claim.date, claim.scope, sha256Hex(canonicalRequest(req, claim))].join('\n');
  const key = signingKey(secret, claim.scope);
  if (!safeEqual(hmacHex(key, stringToSign), claim.signature)) {
    throw new SigV4Error('SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided');
  }
  return key;
}

export type PayloadMode = 'unsigned' | 'sha256' | 'aws-chunked-signed' | 'aws-chunked-unsigned';

export function payloadMode(payloadHash: string): PayloadMode {
  if (payloadHash === UNSIGNED_PAYLOAD) return 'unsigned';
  if (payloadHash === STREAMING_SIGNED || payloadHash === STREAMING_SIGNED_TRAILER) return 'aws-chunked-signed';
  if (payloadHash === STREAMING_UNSIGNED_TRAILER) return 'aws-chunked-unsigned';
  if (/^[0-9a-f]{64}$/.test(payloadHash)) return 'sha256';
  throw new SigV4Error('AuthorizationHeaderMalformed', `Unsupported x-amz-content-sha256: ${payloadHash}`);
}

/**
 * A pass-through that fails the stream at its end if the bytes do not hash to
 * what the client signed. Failing at the end still stops the write: the
 * consumer (the upload path) only commits once the stream finished cleanly.
 */
export function payloadVerifier(expectedSha256: string): Transform {
  const hash = createHash('sha256');
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      callback(hash.digest('hex') === expectedSha256
        ? null
        : new SigV4Error('XAmzContentSHA256Mismatch', 'The provided x-amz-content-sha256 does not match what was computed'));
    },
  });
}

/**
 * Strips aws-chunked framing (`<hex size>[;chunk-signature=<sig>]\r\n<data>\r\n`,
 * ending with a zero-size chunk and optional trailer headers) and, for the
 * signed variant, verifies each chunk's signature against the one before it,
 * starting from the request's seed signature.
 *
 * The trailer (a checksum header in practice) is consumed but not verified:
 * the data it would protect is already covered by the chunk signatures, and in
 * the unsigned variant by nothing at all, exactly as on AWS.
 */
export class AwsChunkedDecoder extends Transform {
  private buffer = Buffer.alloc(0);
  private remaining = 0;
  private chunkSignature = '';
  private chunkHash = createHash('sha256');
  private previousSignature: string;
  private done = false;

  constructor(private readonly signing?: { key: Buffer; date: string; scope: string; seedSignature: string }) {
    super();
    this.previousSignature = signing?.seedSignature ?? '';
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      this.drain();
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  _flush(callback: TransformCallback): void {
    callback(this.done ? null : new Error('aws-chunked body ended before its final chunk'));
  }

  private drain(): void {
    while (!this.done) {
      if (this.remaining > 0) {
        if (!this.buffer.length) return;
        const take = this.buffer.subarray(0, this.remaining);
        this.buffer = this.buffer.subarray(take.length);
        this.remaining -= take.length;
        this.chunkHash.update(take);
        this.push(take);
        if (this.remaining > 0) return;
        continue;
      }
      // Between chunks: the CRLF that closes a data chunk, then the next header.
      const lineEnd = this.buffer.indexOf('\r\n');
      if (lineEnd === -1) return;
      const line = this.buffer.subarray(0, lineEnd).toString('latin1');
      this.buffer = this.buffer.subarray(lineEnd + 2);
      if (line === '') {
        this.verifyChunk();
        continue;
      }
      const [sizeHex, ...extensions] = line.split(';');
      const size = parseInt(sizeHex, 16);
      if (!Number.isInteger(size) || size < 0) throw new Error('Malformed aws-chunked chunk header');
      this.chunkSignature = extensions.find(e => e.startsWith('chunk-signature='))?.slice('chunk-signature='.length) ?? '';
      if (size === 0) {
        this.verifyChunk();
        // Whatever follows (trailer headers, the closing CRLF) carries no data.
        this.done = true;
        this.buffer = Buffer.alloc(0);
        return;
      }
      this.remaining = size;
      this.chunkHash = createHash('sha256');
    }
  }

  private verifyChunk(): void {
    if (!this.signing || !this.chunkSignature) {
      if (this.signing) throw new SigV4Error('SignatureDoesNotMatch', 'A chunk is missing its signature');
      return;
    }
    const stringToSign = [
      'AWS4-HMAC-SHA256-PAYLOAD',
      this.signing.date,
      this.signing.scope,
      this.previousSignature,
      EMPTY_SHA256,
      this.chunkHash.digest('hex'),
    ].join('\n');
    const expected = hmacHex(this.signing.key, stringToSign);
    if (!safeEqual(expected, this.chunkSignature)) {
      throw new SigV4Error('SignatureDoesNotMatch', 'A chunk signature does not match');
    }
    this.previousSignature = expected;
    this.chunkSignature = '';
    this.chunkHash = createHash('sha256');
  }
}
