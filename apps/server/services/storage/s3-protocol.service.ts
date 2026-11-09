import { createHash, randomUUID } from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import { FileStatus, Prisma, type File as FileModel } from '@prisma/client';
import BaseContext from '../../context/base-context';
import { userContentHeaders } from '../../helpers/storage-stream.helper';
import { HttpException } from '../../exceptions/http-exception';
import { logActivity } from '../../lib/activity-log';
import { errorMessage } from '../../lib/errors';
import type { FileAccessScope } from './storage.service';
import type { ByteRange } from './storage.types';
import {
  AwsChunkedDecoder,
  parseSignatureClaim,
  payloadMode,
  payloadVerifier,
  SigV4Error,
  verifySignature,
  type SignatureClaim,
} from './s3-sigv4';
import { xmlBlocks, xmlDocument, xmlText, type XmlNode } from './s3-xml';

/** Every S3 call is service-role: an access key is a project-wide credential, as on Supabase. */
const SERVICE: FileAccessScope = { caller: { serviceRole: true } };
const MULTIPART_PREFIX = '.s3-multipart';
const MAX_XML_BODY = 1024 * 1024;
const MAX_PARTS = 10_000;
/** Highest code point, so `<prefix><this>` sorts after every key under the prefix. */
const AFTER_EVERYTHING = '\u{10FFFF}';

/** An S3 error: the code clients switch on, and its status. */
export class S3Error extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

interface S3Request {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  bucket?: string;
  key?: string;
  query: URLSearchParams;
  claim: SignatureClaim;
  signingKey: Buffer;
}

/** `"<md5>"`, or a stable non-MD5 tag (`-1`, like a multipart ETag) for rows written without one. */
export function etagOf(file: Pick<FileModel, 'id' | 'etag' | 'updatedAt'>): string {
  if (file.etag) return `"${file.etag}"`;
  return `"${createHash('md5').update(`${file.id}:${file.updatedAt.toISOString()}`).digest('hex')}-1"`;
}

/** `Range: bytes=…` against an object of `size` bytes. Undefined means "whole object". */
export function parseRange(header: string | undefined, size: number): ByteRange | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  const range = match[1]
    ? { start: Number(match[1]), end: match[2] ? Math.min(Number(match[2]), size - 1) : size - 1 }
    : { start: Math.max(size - Number(match[2]), 0), end: size - 1 };
  if (range.start > range.end || range.start >= size) {
    throw new S3Error(416, 'InvalidRange', 'The requested range is not satisfiable');
  }
  return range;
}

/** A malformed percent-escape is the caller's mistake, not a server fault. */
export function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new S3Error(400, 'InvalidURI', 'The request path contains an invalid percent-encoding');
  }
}

/** The HttpExceptions StorageService throws, in the vocabulary S3 clients understand. */
export function toS3Error(error: unknown): S3Error {
  if (error instanceof S3Error) return error;
  if (error instanceof SigV4Error) return new S3Error(error.code === 'RequestTimeTooSkewed' || error.code === 'AccessDenied' || error.code === 'SignatureDoesNotMatch' || error.code === 'InvalidAccessKeyId' ? 403 : 400, error.code, error.message);
  if (error instanceof HttpException) {
    const message = error.message;
    switch (error.statusCode) {
      case 404: return /bucket/i.test(message) ? new S3Error(404, 'NoSuchBucket', message) : new S3Error(404, 'NoSuchKey', message);
      case 403: return new S3Error(403, 'AccessDenied', message);
      case 409: return /bucket/i.test(message) && /file/i.test(message) ? new S3Error(409, 'BucketNotEmpty', message) : new S3Error(409, 'OperationAborted', message);
      case 413: return new S3Error(400, 'EntityTooLarge', message);
      case 400: return /size|bytes/i.test(message) ? new S3Error(400, 'EntityTooLarge', message) : new S3Error(400, 'InvalidArgument', message);
      default: return new S3Error(error.statusCode >= 500 ? 500 : error.statusCode, 'InternalError', message);
    }
  }
  return new S3Error(500, 'InternalError', 'We encountered an internal error. Please try again.');
}

/**
 * The S3 protocol, path-style, at `/storage/v1/s3` (Supabase's "S3 connection").
 *
 * S3 buckets are Motherbase buckets and S3 keys are object keys, and every
 * write goes through StorageService, so an object put over S3 is the same row,
 * with the same limits, quota and webhooks, as one uploaded through the SDK.
 * Nothing here talks to a driver for a real object.
 *
 * Supported: ListBuckets, CreateBucket, DeleteBucket, HeadBucket,
 * GetBucketLocation, ListObjects (v1 and v2, prefix/delimiter/pagination,
 * encoding-type=url), GetObject (with Range), HeadObject, PutObject,
 * CopyObject, DeleteObject, DeleteObjects, and multipart upload (Create,
 * UploadPart, ListParts, Complete, Abort). Anything else answers
 * NotImplemented rather than something that merely looks like success.
 */
export class S3ProtocolService extends BaseContext {
  async enabled(): Promise<boolean> {
    const cfg = await this.di.SettingsService.get<{ enabled?: boolean }>('storage.s3');
    return cfg?.enabled !== false;
  }

  /** Serve one request. `mountPath` is where the router answers, e.g. `/storage/v1/s3`. */
  async handle(req: IncomingMessage, res: ServerResponse, mountPath: string): Promise<void> {
    try {
      const request = await this.authenticate(req, res, mountPath);
      await this.dispatch(request);
    } catch (error) {
      if (!(error instanceof S3Error) && !(error instanceof HttpException) && !(error instanceof SigV4Error)) {
        logActivity('error', 'storage', `[s3] ${req.method} ${req.url} failed: ${errorMessage(error)}`);
      }
      this.sendError(req, res, toS3Error(error));
    }
  }

  private async authenticate(req: IncomingMessage, res: ServerResponse, mountPath: string): Promise<S3Request> {
    if (!(await this.enabled())) throw new S3Error(403, 'AccessDenied', 'The S3 protocol is disabled for this project');
    const url = new URL(req.url ?? '/', 'http://s3.local');
    // Signed over the full path the client addressed, mount included.
    const signed = { method: req.method ?? 'GET', path: `${mountPath}${url.pathname === '/' ? '' : url.pathname}` || '/', query: url.searchParams, headers: req.headers };
    const claim = parseSignatureClaim(signed);
    if (!claim) throw new S3Error(403, 'AccessDenied', 'Anonymous S3 requests are not allowed');
    const secret = await this.di.S3AccessKeyService.secretFor(claim.accessKeyId);
    if (!secret) throw new S3Error(403, 'InvalidAccessKeyId', 'The access key id you provided does not exist');
    const signingKey = verifySignature(signed, claim, secret);

    const [bucket, ...key] = url.pathname.split('/').slice(1).map(decodePathSegment);
    return {
      req,
      res,
      method: signed.method,
      bucket: bucket || undefined,
      key: key.length ? key.join('/') : undefined,
      query: url.searchParams,
      claim,
      signingKey,
    };
  }

  private async dispatch(r: S3Request): Promise<void> {
    const { method, bucket, key, query } = r;
    if (!bucket) {
      if (method === 'GET') return this.listBuckets(r);
      throw this.notImplemented();
    }
    if (!key) {
      if (method === 'GET' && query.has('location')) return this.send(r, 200, xmlDocument('LocationConstraint', r.claim.region));
      if (method === 'GET' && query.has('uploads')) return this.listMultipartUploads(r, bucket);
      if (method === 'GET' && [...query.keys()].every(k => ['list-type', 'prefix', 'delimiter', 'max-keys', 'continuation-token', 'start-after', 'marker', 'encoding-type', 'fetch-owner'].includes(k) || k.startsWith('X-Amz-') || k === 'x-id')) {
        return this.listObjects(r, bucket);
      }
      if (method === 'HEAD') return this.headBucket(r, bucket);
      if (method === 'PUT' && ![...query.keys()].some(k => !k.startsWith('X-Amz-') && k !== 'x-id')) return this.createBucket(r, bucket);
      if (method === 'DELETE' && ![...query.keys()].some(k => !k.startsWith('X-Amz-') && k !== 'x-id')) return this.deleteBucket(r, bucket);
      if (method === 'POST' && query.has('delete')) return this.deleteObjects(r, bucket);
      throw this.notImplemented();
    }
    const uploadId = query.get('uploadId');
    switch (method) {
      case 'GET':
        return uploadId ? this.listParts(r, bucket, key, uploadId) : this.getObject(r, bucket, key, true);
      case 'HEAD':
        return this.getObject(r, bucket, key, false);
      case 'PUT':
        if (uploadId) {
          if (r.req.headers['x-amz-copy-source']) throw this.notImplemented('UploadPartCopy');
          return this.uploadPart(r, bucket, key, uploadId);
        }
        if (r.req.headers['x-amz-copy-source']) return this.copyObject(r, bucket, key);
        return this.putObject(r, bucket, key);
      case 'POST':
        if (query.has('uploads')) return this.createMultipart(r, bucket, key);
        if (uploadId) return this.completeMultipart(r, bucket, key, uploadId);
        throw this.notImplemented();
      case 'DELETE':
        return uploadId ? this.abortMultipart(r, uploadId) : this.deleteObject(r, bucket, key);
      default:
        throw this.notImplemented();
    }
  }

  // ── Buckets ───────────────────────────────────────────────────────────────

  private async listBuckets(r: S3Request) {
    const buckets = await this.di.BucketService.list();
    this.send(r, 200, xmlDocument('ListAllMyBucketsResult', {
      Owner: { ID: 'motherbase', DisplayName: 'motherbase' },
      Buckets: { Bucket: buckets.map(b => ({ Name: b.slug, CreationDate: b.createdAt.toISOString() })) },
    }));
  }

  private async headBucket(r: S3Request, bucket: string) {
    await this.di.BucketService.getBySlug(bucket);
    this.send(r, 200);
  }

  private async createBucket(r: S3Request, bucket: string) {
    try {
      await this.di.BucketService.create({ slug: bucket, name: bucket });
    } catch (error) {
      if (error instanceof HttpException && error.statusCode === 409) {
        throw new S3Error(409, 'BucketAlreadyOwnedByYou', error.message);
      }
      if (error instanceof HttpException && error.statusCode === 400) throw new S3Error(400, 'InvalidBucketName', error.message);
      throw error;
    }
    r.res.setHeader('Location', `/${bucket}`);
    this.send(r, 200);
  }

  private async deleteBucket(r: S3Request, bucket: string) {
    await this.di.BucketService.delete(bucket, false);
    this.send(r, 204);
  }

  // ── Listing ───────────────────────────────────────────────────────────────

  /**
   * ListObjects v1 and v2. Ordered byte-wise (COLLATE "C"), which is S3's
   * order and not the database's locale order. With a delimiter, each common
   * prefix is emitted once and the scan jumps past everything under it.
   */
  private async listObjects(r: S3Request, bucketSlug: string) {
    const { query } = r;
    const v2 = query.get('list-type') === '2';
    const bucket = await this.di.BucketService.getBySlug(bucketSlug);
    const prefix = query.get('prefix') ?? '';
    const delimiter = query.get('delimiter') ?? '';
    const maxKeys = Math.min(Math.max(Number(query.get('max-keys') ?? 1000) || 0, 0), 1000);
    const urlEncode = query.get('encoding-type') === 'url';
    const token = query.get('continuation-token');
    const startAfter = v2 ? (token ? Buffer.from(token, 'base64url').toString('utf8') : query.get('start-after') ?? '') : query.get('marker') ?? '';

    const root = `${bucketSlug}/`;
    const after = (cursor: string, limit: number) => this.di.prisma.$queryRaw<FileModel[]>(Prisma.sql`
      SELECT * FROM "storage"."files"
      WHERE "bucketId" = ${bucket.id} AND status = 'ready'
        AND starts_with(key, ${root + prefix})
        AND key COLLATE "C" > ${root + cursor}
      ORDER BY key COLLATE "C"
      LIMIT ${limit}
    `);
    const contents: FileModel[] = [];
    const prefixes: string[] = [];
    let cursor = startAfter;
    while (contents.length + prefixes.length < maxKeys) {
      const rows = await after(cursor, maxKeys - contents.length - prefixes.length);
      if (!rows.length) break;
      for (const row of rows) {
        const name = row.key.slice(root.length);
        const cut = delimiter ? name.indexOf(delimiter, prefix.length) : -1;
        if (cut >= 0) {
          const common = name.slice(0, cut + delimiter.length);
          prefixes.push(common);
          // Query again from past the whole prefix, rather than walking it.
          cursor = common + AFTER_EVERYTHING;
          break;
        }
        contents.push(row);
        cursor = name;
      }
    }
    const truncated = contents.length + prefixes.length >= maxKeys && (await after(cursor, 1)).length > 0;

    const encode = (value: string) => (urlEncode ? encodeURIComponent(value) : value);
    const base: XmlNode = {
      Name: bucketSlug,
      Prefix: encode(prefix),
      Delimiter: delimiter ? encode(delimiter) : undefined,
      MaxKeys: maxKeys,
      EncodingType: urlEncode ? 'url' : undefined,
      IsTruncated: truncated,
      Contents: contents.map(file => ({
        Key: encode(file.key.slice(root.length)),
        LastModified: file.updatedAt.toISOString(),
        ETag: etagOf(file),
        Size: file.size,
        StorageClass: 'STANDARD',
      })),
      CommonPrefixes: prefixes.map(p => ({ Prefix: encode(p) })),
    };
    const next = truncated ? cursor : undefined;
    this.send(r, 200, xmlDocument('ListBucketResult', v2
      ? {
          ...base,
          KeyCount: contents.length + prefixes.length,
          ContinuationToken: token ?? undefined,
          StartAfter: query.get('start-after') ? encode(query.get('start-after')!) : undefined,
          NextContinuationToken: next === undefined ? undefined : Buffer.from(next, 'utf8').toString('base64url'),
        }
      : { ...base, Marker: encode(startAfter), NextMarker: next === undefined || !delimiter ? undefined : encode(next) }));
  }

  // ── Objects ───────────────────────────────────────────────────────────────

  private async getObject(r: S3Request, bucket: string, key: string, withBody: boolean) {
    const file = await this.di.StorageService.findByKey(bucket, key);
    if (file.status !== FileStatus.ready) throw new S3Error(404, 'NoSuchKey', 'The specified key does not exist.');
    const range = parseRange(r.req.headers.range, file.size);
    this.objectHeaders(r.res, file);
    if (range) r.res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
    r.res.setHeader('Content-Length', range ? range.end - range.start + 1 : file.size);
    if (!withBody) {
      r.res.statusCode = 200;
      r.res.end();
      return;
    }
    const object = await this.di.StorageService.openObjectByKey(bucket, key, SERVICE, range);
    r.res.statusCode = range ? 206 : 200;
    await pipeline(object.body, r.res);
  }

  private objectHeaders(res: ServerResponse, file: FileModel) {
    res.setHeader('Content-Type', file.mime ?? 'application/octet-stream');
    for (const [name, value] of Object.entries(userContentHeaders(file.mime))) res.setHeader(name, value);
    res.setHeader('ETag', etagOf(file));
    res.setHeader('Last-Modified', file.updatedAt.toUTCString());
    res.setHeader('Accept-Ranges', 'bytes');
  }

  private async putObject(r: S3Request, bucket: string, key: string) {
    const { body, size } = this.requestBody(r);
    const result = await this.di.StorageService.upload({
      filename: key.split('/').pop() ?? key,
      body,
      size,
      mime: this.contentType(r),
      bucketSlug: bucket,
      objectKey: key,
      // S3 PutObject replaces whatever is at the key.
      upsert: true,
      scope: SERVICE,
    });
    r.res.setHeader('ETag', etagOf(result.file));
    this.send(r, 200);
  }

  private async copyObject(r: S3Request, bucket: string, key: string) {
    const raw = String(r.req.headers['x-amz-copy-source']).split('?')[0];
    const [sourceBucket, ...sourceKey] = decodePathSegment(raw).replace(/^\//, '').split('/');
    if (!sourceBucket || !sourceKey.length) throw new S3Error(400, 'InvalidArgument', 'x-amz-copy-source must be bucket/key');
    const result = await this.di.StorageService.copyObject(sourceBucket, sourceKey.join('/'), key, SERVICE, {
      upsert: true,
      destinationBucket: bucket,
    });
    this.send(r, 200, xmlDocument('CopyObjectResult', {
      ETag: etagOf(result.file),
      LastModified: result.file.updatedAt.toISOString(),
    }));
  }

  private async deleteObject(r: S3Request, bucket: string, key: string) {
    await this.removeIfPresent(bucket, key);
    this.send(r, 204);
  }

  /** S3 deletes are idempotent: a key that is not there is a success, not a 404. */
  private async removeIfPresent(bucket: string, key: string) {
    const file = await this.di.StorageService.findByKeyOrNull(bucket, key);
    if (file) await this.di.StorageService.remove(file.id, SERVICE);
  }

  private async deleteObjects(r: S3Request, bucket: string) {
    await this.di.BucketService.getBySlug(bucket);
    const xml = await this.readXml(r);
    const quiet = xmlText(xml, 'Quiet') === 'true';
    const keys = xmlBlocks(xml, 'Object').map(block => xmlText(block, 'Key')).filter((k): k is string => Boolean(k));
    if (keys.length > 1000) throw new S3Error(400, 'MalformedXML', 'A DeleteObjects request may name at most 1000 keys');
    const deleted: XmlNode[] = [];
    const errors: XmlNode[] = [];
    for (const key of keys) {
      try {
        await this.removeIfPresent(bucket, key);
        if (!quiet) deleted.push({ Key: key });
      } catch (error) {
        const s3 = toS3Error(error);
        errors.push({ Key: key, Code: s3.code, Message: s3.message });
      }
    }
    this.send(r, 200, xmlDocument('DeleteResult', { Deleted: deleted, Error: errors }));
  }

  // ── Multipart ─────────────────────────────────────────────────────────────

  private partKey(uploadId: string, partNumber: number) {
    return `${MULTIPART_PREFIX}/${uploadId}/${partNumber}`;
  }

  private async createMultipart(r: S3Request, bucket: string, key: string) {
    // Refuse up front what the final write would refuse, as resumable uploads do.
    // Size is not known yet, so it is checked per part and again at completion.
    await this.di.StorageService.preflightUpload({ bucketSlug: bucket, objectKey: key, size: 0, mime: this.contentType(r), upsert: true, scope: SERVICE });
    const upload = await this.di.prisma.s3MultipartUpload.create({
      data: { id: randomUUID(), bucketSlug: bucket, key, contentType: this.contentType(r) ?? null },
    });
    this.send(r, 200, xmlDocument('InitiateMultipartUploadResult', { Bucket: bucket, Key: key, UploadId: upload.id }));
  }

  private async requireUpload(uploadId: string, bucket?: string, key?: string) {
    const upload = await this.di.prisma.s3MultipartUpload.findUnique({ where: { id: uploadId } });
    if (!upload || (bucket && upload.bucketSlug !== bucket) || (key && upload.key !== key)) {
      throw new S3Error(404, 'NoSuchUpload', 'The specified multipart upload does not exist.');
    }
    return upload;
  }

  private async uploadPart(r: S3Request, bucket: string, key: string, uploadId: string) {
    const partNumber = Number(r.query.get('partNumber'));
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) {
      throw new S3Error(400, 'InvalidArgument', `partNumber must be between 1 and ${MAX_PARTS}`);
    }
    await this.requireUpload(uploadId, bucket, key);
    const { body, size } = this.requestBody(r);
    // The whole object must still fit the bucket's limit: checked per part so
    // a client cannot stage terabytes it will never be allowed to complete.
    const others = await this.di.prisma.s3MultipartPart.aggregate({
      where: { uploadId, partNumber: { not: partNumber } },
      _sum: { size: true },
    });
    const limits = await this.di.StorageService.uploadLimitsFor(bucket);
    if ((others._sum.size ?? 0) + size > limits.maxBytes) {
      throw new S3Error(400, 'EntityTooLarge', `The object would exceed ${limits.maxBytes} bytes`);
    }
    const etag = await this.di.StorageService.putStagedObject(this.partKey(uploadId, partNumber), body, size);
    await this.di.prisma.s3MultipartPart.upsert({
      where: { uploadId_partNumber: { uploadId, partNumber } },
      create: { uploadId, partNumber, size, etag },
      update: { size, etag },
    });
    r.res.setHeader('ETag', `"${etag}"`);
    this.send(r, 200);
  }

  private async listParts(r: S3Request, bucket: string, key: string, uploadId: string) {
    await this.requireUpload(uploadId, bucket, key);
    const parts = await this.di.prisma.s3MultipartPart.findMany({ where: { uploadId }, orderBy: { partNumber: 'asc' } });
    this.send(r, 200, xmlDocument('ListPartsResult', {
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      IsTruncated: false,
      Part: parts.map(p => ({ PartNumber: p.partNumber, ETag: `"${p.etag}"`, Size: p.size, LastModified: p.createdAt.toISOString() })),
    }));
  }

  private async listMultipartUploads(r: S3Request, bucket: string) {
    await this.di.BucketService.getBySlug(bucket);
    const uploads = await this.di.prisma.s3MultipartUpload.findMany({ where: { bucketSlug: bucket }, orderBy: { createdAt: 'asc' }, take: 1000 });
    this.send(r, 200, xmlDocument('ListMultipartUploadsResult', {
      Bucket: bucket,
      IsTruncated: false,
      Upload: uploads.map(u => ({ Key: u.key, UploadId: u.id, Initiated: u.createdAt.toISOString(), StorageClass: 'STANDARD' })),
    }));
  }

  /**
   * Stitch the named parts, in order, into one stream and hand it to
   * `StorageService.upload`: limits, quota, the row and webhooks are exactly a
   * PutObject's. The ETag is the whole object's MD5 rather than AWS's
   * MD5-of-MD5s, which is a stronger answer to the same question.
   */
  private async completeMultipart(r: S3Request, bucket: string, key: string, uploadId: string) {
    const upload = await this.requireUpload(uploadId, bucket, key);
    const xml = await this.readXml(r);
    const requested = xmlBlocks(xml, 'Part').map(block => ({
      partNumber: Number(xmlText(block, 'PartNumber')),
      etag: (xmlText(block, 'ETag') ?? '').replace(/"/g, ''),
    }));
    if (!requested.length) throw new S3Error(400, 'MalformedXML', 'CompleteMultipartUpload must list at least one part');
    const stored = new Map((await this.di.prisma.s3MultipartPart.findMany({ where: { uploadId } })).map(p => [p.partNumber, p]));
    let previous = 0;
    for (const part of requested) {
      if (part.partNumber <= previous) throw new S3Error(400, 'InvalidPartOrder', 'Parts must be listed in ascending order');
      previous = part.partNumber;
      if (stored.get(part.partNumber)?.etag !== part.etag) throw new S3Error(400, 'InvalidPart', `Part ${part.partNumber} was not uploaded, or its ETag does not match`);
    }

    const storage = this.di.StorageService;
    const keys = requested.map(part => this.partKey(uploadId, part.partNumber));
    async function* concatenated() {
      for (const partKey of keys) yield* await storage.openStagedObject(partKey);
    }
    const result = await storage.upload({
      filename: key.split('/').pop() ?? key,
      body: Readable.from(concatenated()),
      size: requested.reduce((sum, part) => sum + stored.get(part.partNumber)!.size, 0),
      mime: upload.contentType ?? undefined,
      bucketSlug: bucket,
      objectKey: key,
      upsert: true,
      scope: SERVICE,
    });
    await this.discardUpload(uploadId, [...stored.keys()]);
    this.send(r, 200, xmlDocument('CompleteMultipartUploadResult', {
      Location: `/${bucket}/${key}`,
      Bucket: bucket,
      Key: key,
      ETag: etagOf(result.file),
    }));
  }

  private async abortMultipart(r: S3Request, uploadId: string) {
    await this.requireUpload(uploadId);
    const parts = await this.di.prisma.s3MultipartPart.findMany({ where: { uploadId }, select: { partNumber: true } });
    await this.discardUpload(uploadId, parts.map(p => p.partNumber));
    this.send(r, 204);
  }

  private async discardUpload(uploadId: string, partNumbers: number[]) {
    for (const partNumber of partNumbers) {
      await this.di.StorageService.removeStagedObject(this.partKey(uploadId, partNumber)).catch(error => {
        logActivity('error', 'storage', `[s3] failed to remove staged part ${uploadId}/${partNumber}: ${errorMessage(error)}`);
      });
    }
    await this.di.prisma.s3MultipartUpload.deleteMany({ where: { id: uploadId } });
  }

  /** Abandoned multipart uploads, older than a day. Run by the storage cleanup job. */
  async cleanupExpired(now = new Date()): Promise<number> {
    const stale = await this.di.prisma.s3MultipartUpload.findMany({
      where: { createdAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
      include: { parts: { select: { partNumber: true } } },
      take: 100,
    });
    let cleaned = 0;
    for (const upload of stale) {
      // One broken upload must not strand the rest of the batch.
      try {
        await this.discardUpload(upload.id, upload.parts.map(p => p.partNumber));
        cleaned++;
      } catch (error) {
        logActivity('error', 'storage', `[s3] failed to discard expired upload ${upload.id}: ${errorMessage(error)}`);
      }
    }
    return cleaned;
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  private contentType(r: S3Request): string | undefined {
    const value = r.req.headers['content-type'];
    return typeof value === 'string' && value ? value : undefined;
  }

  /** The request body as the object's bytes: de-chunked and integrity-checked per the signed payload mode. */
  private requestBody(r: S3Request): { body: Readable; size: number } {
    const mode = payloadMode(r.claim.payloadHash);
    const chunked = mode === 'aws-chunked-signed' || mode === 'aws-chunked-unsigned';
    const size = Number(chunked ? r.req.headers['x-amz-decoded-content-length'] : r.req.headers['content-length']);
    if (!Number.isSafeInteger(size) || size < 0) throw new S3Error(411, 'MissingContentLength', 'You must provide the Content-Length HTTP header.');
    if (mode === 'sha256') return { body: r.req.pipe(payloadVerifier(r.claim.payloadHash)), size };
    if (chunked) {
      const decoder = new AwsChunkedDecoder(mode === 'aws-chunked-signed'
        ? { key: r.signingKey, date: r.claim.date, scope: r.claim.scope, seedSignature: r.claim.signature }
        : undefined);
      return { body: r.req.pipe(decoder), size };
    }
    return { body: r.req, size };
  }

  private async readXml(r: S3Request): Promise<string> {
    const chunks: Buffer[] = [];
    let length = 0;
    const { body } = this.requestBody(r);
    for await (const chunk of body) {
      length += chunk.length;
      if (length > MAX_XML_BODY) throw new S3Error(400, 'MalformedXML', 'The XML body is too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private notImplemented(operation = 'This operation'): S3Error {
    return new S3Error(501, 'NotImplemented', `${operation} is not implemented by this S3 endpoint`);
  }

  private send(r: S3Request, status: number, xml?: string) {
    r.res.statusCode = status;
    if (xml) {
      r.res.setHeader('Content-Type', 'application/xml');
      r.res.setHeader('Content-Length', Buffer.byteLength(xml));
    }
    r.res.end(xml);
  }

  private sendError(req: IncomingMessage, res: ServerResponse, error: S3Error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.statusCode = error.status;
    // A HEAD answer has no body; the status is all a client gets.
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const xml = xmlDocument('Error', { Code: error.code, Message: error.message, Resource: req.url ?? '/' }, { namespaced: false });
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Length', Buffer.byteLength(xml));
    res.end(xml);
  }
}
