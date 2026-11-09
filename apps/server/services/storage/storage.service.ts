import type { RlsUser } from '../../lib/rls-claims';
import type { StorageObjectRef } from './storage-policy.service';
import * as uuid from 'uuid';
import path from 'path';
import { createHash } from 'crypto';
import type { Readable } from 'stream';
import { FileStatus, FileVisibility, File as FileModel } from '@prisma/client';
import type { StorageRemoveContract } from '@motherbase/contracts';
import BaseContext from '../../context/base-context';
import IContextContainer from '../../context/icontext-container';
import { HttpException } from '../../exceptions/http-exception';
import { env } from '../../config/env';
import { IStorageDriver, type ByteRange } from './storage.types';
import { buildFileWhere, filePage, type FileListFilters } from './file-query';
import { LocalStorageDriver } from './local.driver';
import { S3StorageDriver } from './s3.driver';
import { UploadReservationStore } from './upload-reservation.store';
import { exactSizeStream } from './sized-stream';
import { logActivity } from '../../lib/activity-log';
import { errorMessage } from '../../lib/errors';
import { signUploadToken, verifyUploadToken } from './upload-token';
import { assertWithinLimits, effectiveUploadLimits, parseMimeList, type UploadLimits } from './upload-limits';

/** One page of the storage browser, with totals for everything the filter matches. */
export interface FileListPage {
  rows: any[];
  total: number;
  page: number;
  pageSize: number;
  /** Bytes across every matching file, not just this page. */
  totalSize: number;
}

const DOWNLOAD_URL_TTL = 3600; // 1h
const UPLOAD_URL_TTL = 900; // 15m
/** AWS SigV4 refuses a presign lifetime above 7 days, so neither do we. */
export const MAX_DOWNLOAD_URL_TTL = 604800; // 7d

/**
 * Validate a caller-supplied download-URL lifetime, in seconds.
 *
 * Rejects rather than clamps: a caller asking for 30 days wants a 30-day URL,
 * and silently handing back a 7-day one is how `expiresIn` came to be ignored
 * in the first place. `undefined` means "use the default".
 */
export function parseExpiresIn(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_DOWNLOAD_URL_TTL) {
    throw new HttpException(
      `expiresIn must be a whole number of seconds between 1 and ${MAX_DOWNLOAD_URL_TTL} (7 days).`,
      400,
    );
  }
  return seconds;
}

export { mimeAllowed } from './upload-limits';

interface UploadInput {
  ownerId?: string;
  filename: string;
  body: Readable;
  size: number;
  mime?: string;
  visibility?: FileVisibility;
  bucketSlug?: string;
  /** Trusted internal key prefix (for example `avatars/<userId>`). */
  namespace?: string;
  /**
   * Caller-supplied object key, relative to the bucket: `123/avatar.png`. When
   * absent the server generates one, which is the pre-6.5 behaviour.
   */
  objectKey?: string;
  /** Replace an object already at that key instead of refusing the upload. */
  upsert?: boolean;
  /**
   * The caller, for authorization. `ownerId` says who the new object will
   * belong to, which is not the same question: an upsert over someone else's
   * object is decided against the caller, never against that object's owner.
   */
  scope?: FileAccessScope;
}

/** Longest object key accepted. Both S3 and every filesystem stop well short of this. */
const MAX_KEY_LENGTH = 1024;

/**
 * Normalise a caller-supplied object key, or refuse it.
 *
 * The key reaches a filesystem path (local driver) and an S3 key, so this is a
 * security boundary, not a tidiness pass. It refuses anything that could climb
 * out of its bucket rather than trying to sanitise it into something safe:
 * a key that needed rewriting is a key the caller did not mean.
 */
export function normalizeObjectKey(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw new HttpException('Object key is required', 400);
  if (value.length > MAX_KEY_LENGTH) throw new HttpException('Object key is too long', 400);
  // Backslashes are path separators on Windows, so they cannot be treated as
  // ordinary characters just because S3 would allow them.
  if (value.includes('\\')) throw new HttpException('Object key may not contain a backslash', 400);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new HttpException('Object key may not contain control characters', 400);

  const segments = value.replace(/^\/+/, '').split('/');
  for (const segment of segments) {
    if (segment === '') throw new HttpException('Object key may not contain an empty path segment', 400);
    if (segment === '.' || segment === '..') {
      throw new HttpException('Object key may not contain a relative path segment', 400);
    }
  }
  return segments.join('/');
}

/**
 * What a caller has proven about itself. A session proves a user id; a verified
 * bucket token proves authority over one bucket. Access requires a claim that
 * matches the file: an empty scope grants nothing.
 */
export interface FileAccessScope {
  userId?: string;
  bucketId?: string;
  /**
   * The caller as the data plane sees it, when policy-based authorization is on.
   * Absent on internal callers (schedulers, cleanup), which is why the fallback
   * below rebuilds a minimal one from `userId` rather than treating "no caller"
   * as "anonymous".
   */
  caller?: RlsUser;
}

interface PresignInput {
  ownerId?: string;
  filename: string;
  size: unknown;
  mime?: string;
  visibility?: FileVisibility;
  bucketSlug?: string;
  /** Caller-supplied key, so a presigned upload lands where the caller asked. */
  objectKey?: string;
  /** The caller, for authorization. See `UploadInput.scope`. */
  scope?: FileAccessScope;
}

/**
 * Storage facade: routes object I/O through the configured driver (local or S3)
 * and records every object in the `File` table. Consumers never touch the
 * driver directly: they get back a `File` row plus a usable URL.
 */
export class StorageService extends BaseContext {
  private driver: IStorageDriver;
  private reservations: UploadReservationStore;
  // Public and private objects live in separate buckets so a public/anonymous
  // download policy never exposes private objects.
  private publicBucket = StorageService.sanitizeBucket(env.S3_PUBLIC_BUCKET || 'public');
  private privateBucket = StorageService.sanitizeBucket(env.S3_BUCKET || 'uploads');
  private isLocal = env.STORAGE_DRIVER !== 's3';

  constructor(di: IContextContainer) {
    super(di);
    this.driver = env.STORAGE_DRIVER === 's3' ? new S3StorageDriver() : new LocalStorageDriver();
    this.reservations = new UploadReservationStore(di.prisma);
  }

  /** DNS-safe bucket names only; rejects path separators / traversal characters. */
  private static sanitizeBucket(name: string): string {
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) {
      throw new HttpException(`Invalid storage bucket name: ${name}`, 400);
    }
    return name;
  }

  /**
   * Bucket is derived from visibility, never from client input. This removes
   * the arbitrary-bucket / path-traversal vector entirely.
   */
  private bucketFor(visibility: FileVisibility): string {
    return visibility === FileVisibility.public ? this.publicBucket : this.privateBucket;
  }

  private baseHost(): string {
    return env.BASE_HOST.startsWith('http') ? env.BASE_HOST : `http://${env.BASE_HOST}`;
  }

  private buildKey(filename: string, prefix?: string, objectKey?: string) {
    if (prefix && !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(prefix)) {
      throw new HttpException('Invalid storage namespace', 400);
    }
    // A caller-supplied key is the whole point of path addressing: the object is
    // findable later by the name the application chose, not by an id it has to
    // have stored somewhere.
    if (objectKey) {
      const normalized = normalizeObjectKey(objectKey);
      return prefix ? `${prefix}/${normalized}` : normalized;
    }
    const ext = path.extname(filename || '');
    const fileId = uuid.v4();
    return prefix ? `${prefix}/${fileId}${ext}` : `${fileId}${ext}`;
  }

  private async reserveUpload(candidate: Awaited<ReturnType<StorageService['candidateFor']>>, size: number, mime?: string) {
    return {
      file: await this.reservations.reserve({
        ...candidate,
        ownerId: candidate.ownerId ?? undefined,
        bucketId: candidate.bucketId ?? undefined,
        size,
        mime,
        uploadExpiresAt: new Date(Date.now() + UPLOAD_URL_TTL * 1000),
      }),
    };
  }

  /**
   * The static URL a public object in `bucket` resolves to, straight from the
   * driver. The importer needs the prefix (key `''`) to rewrite rows that still
   * hold the source project's storage URLs.
   */
  publicObjectUrl(bucket: string, key: string): string {
    return this.driver.publicUrl(bucket, key);
  }

  private publicUrlFor(file: FileModel): string | null {
    return file.visibility === FileVisibility.public ? this.driver.publicUrl(file.bucket, file.key) : null;
  }

  private dispatchUploadedWebhook(file: FileModel): void {
    if (!file.bucketId) return;
    void this.di.BucketService.dispatchWebhook(file.bucketId, 'file.uploaded', {
      id: file.id,
      key: file.key,
      mime: file.mime,
      size: file.size,
    });
  }

  /**
   * The limits an upload into `bucketSlug` is held to: the live storage.limits
   * settings narrowed by the bucket's own, falling back to the env ceiling (and
   * no MIME restriction) when settings are unavailable.
   *
   * Public because every upload door (multipart, presign, resumable, S3) has to
   * apply the same answer, and the ones outside this class ask for it up front.
   */
  async uploadLimitsFor(bucketSlug?: string): Promise<UploadLimits> {
    let maxBytes = env.MAX_UPLOAD_BYTES;
    // Independent lookups, so they overlap instead of queueing.
    const [cfg, bucket] = await Promise.all([
      // Settings storage unavailable: keep uploads working at the env ceiling.
      (async () => this.di.SettingsService.get<{ maxUploadBytes: number; allowedMimeTypes: string }>('storage.limits'))()
        .catch(() => null),
      bucketSlug ? this.di.BucketService.getBySlug(bucketSlug) : null,
    ]);
    const configured = Number(cfg?.maxUploadBytes) || 0;
    if (configured > 0) maxBytes = Math.min(configured, env.MAX_UPLOAD_BYTES);
    const allowedMimeTypes = parseMimeList(cfg?.allowedMimeTypes);
    return effectiveUploadLimits({ maxBytes, allowedMimeTypes }, bucket);
  }

  private async enforceUploadLimits(rawSize: unknown, mime?: string, bucketSlug?: string): Promise<number> {
    return assertWithinLimits(await this.uploadLimitsFor(bucketSlug), rawSize, mime);
  }

  async upload({
    ownerId,
    filename,
    body,
    size: rawSize,
    mime,
    visibility = FileVisibility.private,
    bucketSlug,
    namespace,
    objectKey,
    upsert,
    scope = {},
  }: UploadInput) {
    const size = await this.enforceUploadLimits(rawSize, mime, bucketSlug);
    // Path addressing makes a key collision a real case rather than a
    // theoretical one, and the two answers are different enough that guessing is
    // wrong: silently replacing someone's object, or silently keeping the old
    // bytes under a name the caller thinks it just wrote.
    if (objectKey && bucketSlug) {
      const existing = await this.findByKeyOrNull(bucketSlug, objectKey);
      if (existing && !upsert) {
        throw new HttpException(`An object already exists at ${bucketSlug}/${normalizeObjectKey(objectKey)}`, 409);
      }
      if (existing) return this.replaceObject(existing, { body, size, mime, scope });
    }
    const candidate = await this.candidateFor({ ownerId, filename, visibility, bucketSlug, namespace, objectKey });
    await this.assertWritable('insert', { ...candidate, size, mime }, scope);
    let verifiedBody: Readable | undefined;
    try {
      const reserved = await this.reserveUpload(candidate, size, mime);

      let file: FileModel;
      try {
        const md5 = createHash('md5');
        verifiedBody = exactSizeStream(body, size, md5);
        await this.driver.put({
          bucket: reserved.file.bucket,
          key: reserved.file.key,
          body: verifiedBody,
          contentLength: size,
          contentType: mime,
          visibility: reserved.file.visibility,
        });
        file = await this.reservations.activate(reserved.file.id, this.publicUrlFor(reserved.file), md5.digest('hex'));
      } catch (error) {
        // The reservation may already have been removed by cleanup. Always delete
        // the physical key so a successful PUT cannot become an orphan.
        await this.driver.delete(reserved.file.bucket, reserved.file.key).catch(cleanupError => {
          logActivity('error', 'storage', `[storage] failed to remove incomplete object: ${errorMessage(cleanupError)}`);
        });
        await this.reservations.release(reserved.file.id).catch(cleanupError => {
          logActivity('error', 'storage', `[storage] failed to release upload reservation: ${errorMessage(cleanupError)}`);
        });
        throw error;
      }
      logActivity('info', 'storage', `[storage] upload ${file.bucket}/${file.key} (${size} bytes, ${mime})`);
      this.dispatchUploadedWebhook(file);
      return { file, url: await this.uploadResultUrl(file, scope) };
    } finally {
      verifiedBody?.destroy();
      body.destroy();
    }
  }

  /**
   * The row an `insert` policy is asked about, before anything is written.
   *
   * It mirrors what `reserveUpload` is about to create, so the policy decides on
   * the object the caller actually asked for rather than on a placeholder.
   */
  private async candidateFor(input: {
    ownerId?: string;
    filename: string;
    visibility: FileVisibility;
    bucketSlug?: string;
    namespace?: string;
    objectKey?: string;
  }) {
    let bucketId: string | undefined;
    let visibility = input.visibility;
    if (input.bucketSlug) {
      const bucket = await this.di.BucketService.getBySlug(input.bucketSlug);
      bucketId = bucket.id;
      visibility = bucket.visibility;
    }
    return {
      bucketId: bucketId ?? null,
      bucket: this.bucketFor(visibility),
      key: this.buildKey(input.filename, input.bucketSlug ?? input.namespace, input.objectKey),
      ownerId: input.ownerId ?? null,
      visibility,
    };
  }

  /**
   * Upsert over an existing object: overwrite the bytes at the same key.
   *
   * The old object is never deleted first. Both drivers write atomically (the
   * local one through a temporary file and a rename, S3 by definition), so a
   * failed replacement leaves the previous bytes readable instead of destroying
   * them on the way to an upload that then failed on quota, disk or network.
   * The row is reused too, which is what `@@unique([bucket, key])` requires.
   */
  private async replaceObject(
    existing: FileModel,
    input: { body: Readable; size: number; mime?: string; scope: FileAccessScope },
  ) {
    await this.assertWritable('update', { ...existing, size: input.size, mime: input.mime ?? existing.mime }, input.scope);
    // Quota before bytes: the delta can be negative, and a replacement that the
    // bucket cannot afford must fail before anything is overwritten.
    await this.reservations.assertReplacementFits(existing, input.size);

    let verifiedBody: Readable | undefined;
    try {
      const md5 = createHash('md5');
      verifiedBody = exactSizeStream(input.body, input.size, md5);
      await this.driver.put({
        bucket: existing.bucket,
        key: existing.key,
        body: verifiedBody,
        contentLength: input.size,
        contentType: input.mime,
        visibility: existing.visibility,
      });
      const file = await this.reservations.completeReplacement(existing.id, {
        size: input.size,
        mime: input.mime,
        url: this.publicUrlFor(existing),
        etag: md5.digest('hex'),
      });
      logActivity('info', 'storage', `[storage] upsert ${file.bucket}/${file.key} (${input.size} bytes, ${input.mime})`);
      this.dispatchUploadedWebhook(file);
      return { file, url: await this.uploadResultUrl(file, input.scope) };
    } finally {
      verifiedBody?.destroy();
      input.body.destroy();
    }
  }

  /**
   * Everything `upload()` would refuse, asked before the bytes exist.
   *
   * Resumable and multipart uploads arrive in pieces over minutes or hours, so
   * the answer is wanted when the upload is created: limits, key collision,
   * the insert/update policy and the bucket quota. Nothing is reserved; the
   * final `upload()` checks all of it again, which is what makes a race between
   * two uploads to one key end in a clean 409 rather than a lost write.
   */
  async preflightUpload(input: {
    ownerId?: string;
    bucketSlug: string;
    objectKey: string;
    size: unknown;
    mime?: string;
    upsert?: boolean;
    scope?: FileAccessScope;
  }): Promise<void> {
    const scope = input.scope ?? {};
    const size = await this.enforceUploadLimits(input.size, input.mime, input.bucketSlug);
    const existing = await this.findByKeyOrNull(input.bucketSlug, input.objectKey);
    if (existing && !input.upsert) {
      throw new HttpException(`An object already exists at ${input.bucketSlug}/${normalizeObjectKey(input.objectKey)}`, 409);
    }
    if (existing) {
      await this.assertWritable('update', { ...existing, size, mime: input.mime ?? existing.mime }, scope);
      await this.reservations.assertReplacementFits(existing, size);
      return;
    }
    const candidate = await this.candidateFor({
      ownerId: input.ownerId,
      filename: path.basename(input.objectKey),
      visibility: FileVisibility.private,
      bucketSlug: input.bucketSlug,
      objectKey: input.objectKey,
    });
    await this.assertWritable('insert', { ...candidate, size, mime: input.mime }, scope);
    if (candidate.bucketId) await this.reservations.assertFits(candidate.bucketId, size);
  }

  /** Reserve quota and issue a size-bound PUT URL for direct S3 upload. */
  async presignUpload({
    ownerId,
    filename,
    size: rawSize,
    mime,
    visibility = FileVisibility.private,
    bucketSlug,
    objectKey,
    scope = {},
  }: PresignInput) {
    const size = await this.enforceUploadLimits(rawSize, mime, bucketSlug);
    // The row is created here but written to by the client, so the collision has
    // to be answered now: `@@unique([bucket, key])` would otherwise surface as a
    // 500 at reservation time. There is no presigned upsert.
    if (objectKey && bucketSlug && (await this.findByKeyOrNull(bucketSlug, objectKey))) {
      throw new HttpException(`An object already exists at ${bucketSlug}/${normalizeObjectKey(objectKey)}`, 409);
    }
    const candidate = await this.candidateFor({ ownerId, filename, visibility, bucketSlug, objectKey });
    await this.assertWritable('insert', { ...candidate, size, mime }, scope);
    const reserved = await this.reserveUpload(candidate, size, mime);

    try {
      const uploadUrl = await this.driver.getSignedUploadUrl({
        bucket: reserved.file.bucket,
        key: reserved.file.key,
        expiresInSec: UPLOAD_URL_TTL,
        contentLength: size,
        contentType: mime,
      });
      return {
        file: reserved.file,
        uploadUrl,
        finalizeToken: signUploadToken(reserved.file, reserved.file.uploadExpiresAt!.getTime(), env.JWT_SECRET),
      };
    } catch (err) {
      await this.reservations.release(reserved.file.id);
      throw err;
    }
  }

  async finalizeUpload(fileId: string, scope: FileAccessScope, token?: unknown) {
    const result = await this.reservations.finalize(
      fileId,
      async file => {
        if (scope.caller?.serviceRole || (scope.userId && file.ownerId === scope.userId)
          || verifyUploadToken(token, file, env.JWT_SECRET)) return;
        this.denied('write', file, scope);
      },
      file => this.driver.headObject(file.bucket, file.key),
      file => this.publicUrlFor(file)
    );
    if (result.finalized) this.dispatchUploadedWebhook(result.file);
    return { file: result.file, url: await this.uploadResultUrl(result.file, scope) };
  }

  /** INSERT/finalization permission does not grant a signed read capability. */
  private async uploadResultUrl(file: FileModel, scope: FileAccessScope): Promise<string | null> {
    try {
      await this.assertReadable(file, scope);
      return await this.urlFor(file);
    } catch (error) {
      // The upload is already committed. A denied/unavailable URL must neither
      // delete its bytes nor report that the write failed. It can be requested later.
      if (!(error instanceof HttpException && error.statusCode === 403)) {
        logActivity('warn', 'storage', `[storage] upload URL unavailable for ${file.id}: ${errorMessage(error)}`);
      }
      return null;
    }
  }

  /**
   * Scratch objects (S3 multipart parts) in the private physical bucket, under
   * a prefix no object key can take. They have no row: whoever writes one owns
   * its lifecycle. Returns the hex MD5 of what was written.
   */
  async putStagedObject(key: string, body: Readable, size: number): Promise<string> {
    const md5 = createHash('md5');
    const verified = exactSizeStream(body, size, md5);
    try {
      await this.driver.put({ bucket: this.privateBucket, key, body: verified, contentLength: size, visibility: FileVisibility.private });
    } finally {
      verified.destroy();
    }
    return md5.digest('hex');
  }

  async openStagedObject(key: string): Promise<Readable> {
    return (await this.driver.getObject(this.privateBucket, key)).body;
  }

  async removeStagedObject(key: string): Promise<void> {
    await this.driver.delete(this.privateBucket, key);
  }

  async cleanupExpiredReservations(now = new Date()): Promise<number> {
    return this.reservations.cleanupExpired(file => this.driver.delete(file.bucket, file.key), now);
  }

  /**
   * Resolve a usable URL for a file: a public URL for public objects, an S3
   * presigned URL for private objects on S3, and an authenticated streaming
   * endpoint for private objects on the local driver (never a static URL).
   */
  private async urlFor(file: FileModel, expiresInSec: number = DOWNLOAD_URL_TTL): Promise<string> {
    if (file.visibility === FileVisibility.public) {
      return file.url ?? this.driver.publicUrl(file.bucket, file.key);
    }
    if (this.isLocal) return `${this.baseHost()}/api/files/${file.id}/raw`;
    return this.driver.getSignedDownloadUrl(file.bucket, file.key, expiresInSec);
  }

  /**
   * A download URL together with when it stops working, so a caller that asked
   * for a lifetime can tell whether it actually got one.
   *
   * Only an S3 presign expires. A public object's URL is permanent, and a
   * private object on the local driver resolves to the authenticated streaming
   * endpoint, not time-limited, but useless to anyone without the session, so
   * it cannot be handed to a third party the way a signed URL can. Both report
   * `expiresAt: null` rather than pretending the requested lifetime applied.
   */
  private async describeUrl(
    file: FileModel,
    expiresInSec?: number,
  ): Promise<{ url: string; expiresAt: Date | null }> {
    const ttl = expiresInSec ?? DOWNLOAD_URL_TTL;
    const url = await this.urlFor(file, ttl);
    const isSigned = file.visibility !== FileVisibility.public && !this.isLocal;
    return { url, expiresAt: isSigned ? new Date(Date.now() + ttl * 1000) : null };
  }

  /**
   * Resolve `bucket/key` to a row.
   *
   * The stored key is bucket-prefixed (`avatars/123/pic.png` in bucket
   * `avatars`), which is also how it is laid out on disk and in S3, so one
   * string identifies the object at every layer. Lookups are additionally
   * scoped by bucket id: two buckets may legitimately hold the same key.
   */
  async findByKey(bucketSlug: string, objectKey: string) {
    const key = `${bucketSlug}/${normalizeObjectKey(objectKey)}`;
    const bucket = await this.di.BucketService.getBySlug(bucketSlug);
    const file = await this.di.prisma.file.findFirst({ where: { bucketId: bucket.id, key } });
    if (!file) throw new HttpException('File not found', 404);
    return file;
  }

  /** Like `findByKey`, but absence is an answer rather than a 404. */
  async findByKeyOrNull(bucketSlug: string, objectKey: string) {
    const key = `${bucketSlug}/${normalizeObjectKey(objectKey)}`;
    const bucket = await this.di.BucketService.getBySlug(bucketSlug);
    return this.di.prisma.file.findFirst({ where: { bucketId: bucket.id, key } });
  }

  async getDownloadUrlByKey(
    bucketSlug: string,
    objectKey: string,
    scope: FileAccessScope = {},
    expiresInSec?: number,
  ) {
    const file = await this.findByKey(bucketSlug, objectKey);
    if (file.status !== FileStatus.ready) throw new HttpException('File not found', 404);
    await this.assertReadable(file, scope);
    return this.describeUrl(file, expiresInSec);
  }

  async streamFileByKey(bucketSlug: string, objectKey: string, scope: FileAccessScope = {}) {
    const file = await this.findByKey(bucketSlug, objectKey);
    if (file.status !== FileStatus.ready) throw new HttpException('File not found', 404);
    await this.assertReadable(file, scope);
    const object = await this.driver.getObject(file.bucket, file.key);
    return {
      body: object.body,
      contentLength: object.contentLength,
      mime: file.mime ?? object.contentType ?? 'application/octet-stream',
    };
  }

  /**
   * An authorized object together with its row: the S3 protocol answers from
   * both (ETag, Last-Modified come from the row, the bytes from the driver),
   * and can ask for a byte range.
   */
  async openObjectByKey(bucketSlug: string, objectKey: string, scope: FileAccessScope = {}, range?: ByteRange) {
    const file = await this.findByKey(bucketSlug, objectKey);
    if (file.status !== FileStatus.ready) throw new HttpException('File not found', 404);
    await this.assertReadable(file, scope);
    const object = await this.driver.getObject(file.bucket, file.key, range);
    return { file, body: object.body, contentLength: object.contentLength };
  }

  /**
   * The public bucket routes are addressed `/<bucket>/files/:id`, but the SDK's
   * `getPublicUrl(path)` fills that segment with an object key: the URL it hands
   * out 404'd because the key was looked up as an id. Both addressing modes are
   * accepted here, told apart by shape, so a public URL resolves whichever way
   * it was built. A uuid is never a valid key for an object the server stored,
   * since stored keys are always bucket-prefixed.
   */
  private static isFileId(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  async streamFileByIdOrKey(bucketSlug: string, idOrKey: string, scope: FileAccessScope = {}) {
    return StorageService.isFileId(idOrKey)
      ? this.streamFile(idOrKey, scope)
      : this.streamFileByKey(bucketSlug, idOrKey, scope);
  }

  async removeByIdOrKey(
    bucketSlug: string,
    idOrKey: string,
    scope: FileAccessScope = {},
  ): Promise<StorageRemoveContract> {
    return StorageService.isFileId(idOrKey)
      ? this.remove(idOrKey, scope)
      : this.removeByKey(bucketSlug, idOrKey, scope);
  }

  async removeByKey(
    bucketSlug: string,
    objectKey: string,
    scope: FileAccessScope = {}
  ): Promise<StorageRemoveContract> {
    const file = await this.findByKey(bucketSlug, objectKey);
    return this.removeResolved(file, scope);
  }

  /**
   * One object's metadata, in the shape `listObjects` uses for a row.
   *
   * Read authorization is the same as a download's: knowing whether an object
   * exists is information, so this must not answer for an object the caller
   * could not read.
   */
  async statObject(bucketSlug: string, objectKey: string, scope: FileAccessScope = {}) {
    const file = await this.findByKey(bucketSlug, objectKey);
    if (file.status !== FileStatus.ready) throw new HttpException('File not found', 404);
    await this.assertReadable(file, scope);
    return {
      name: String(file.key).slice(bucketSlug.length + 1),
      id: file.id,
      version: file.updatedAt?.toISOString?.() ?? null,
      bucket_id: bucketSlug,
      updated_at: file.updatedAt?.toISOString?.() ?? null,
      created_at: file.createdAt?.toISOString?.() ?? null,
      last_accessed_at: null,
      size: Number(file.size),
      content_type: file.mime ?? null,
      cache_control: null,
      metadata: {
        size: Number(file.size),
        mimetype: file.mime ?? null,
        cacheControl: null,
      },
    };
  }

  /**
   * Copy an object to another key in the same bucket.
   *
   * The bytes are streamed through `upload()` rather than copied inside the
   * driver, so quota reservation, the size guard, the mime allowlist, upsert
   * semantics and the upload webhook all apply to the copy exactly as they do
   * to a fresh upload. One implementation covers both drivers.
   *
   * ponytail: a same-bucket S3 copy could be a server-side CopyObject instead
   * of a round trip through this process. Add a `copy` to IStorageDriver if
   * large-object copies ever show up in a profile.
   */
  async copyObject(
    bucketSlug: string,
    fromKey: string,
    toKey: string,
    scope: FileAccessScope = {},
    options: { upsert?: boolean; destinationBucket?: string } = {},
  ) {
    const source = await this.findByKey(bucketSlug, fromKey);
    // The copy belongs to whoever asked for it, not to the source's owner:
    // otherwise a reader could grow another user's quota.
    return this.copyResolved(source, options.destinationBucket ?? bucketSlug, toKey, scope, options, scope.userId);
  }

  private async copyResolved(
    source: FileModel,
    bucketSlug: string,
    toKey: string,
    scope: FileAccessScope,
    options: { upsert?: boolean },
    ownerId: string | undefined,
  ) {
    if (source.status !== FileStatus.ready) throw new HttpException('File not found', 404);
    await this.assertReadable(source, scope);

    const destination = normalizeObjectKey(toKey);
    if (`${bucketSlug}/${destination}` === source.key && source.bucketId === (await this.di.BucketService.getBySlug(bucketSlug)).id) {
      throw new HttpException('The source and destination keys are the same', 400);
    }

    const object = await this.driver.getObject(source.bucket, source.key);
    const created = await this.upload({
      ownerId,
      filename: path.basename(destination),
      body: object.body,
      size: Number(source.size),
      mime: source.mime ?? undefined,
      visibility: source.visibility,
      bucketSlug,
      objectKey: destination,
      upsert: options.upsert,
      // The copy is a write by whoever asked for it, so it is authorized as one.
      scope,
    });
    return { path: destination, id: created.file.id, fullPath: `${bucketSlug}/${destination}`, file: created.file };
  }

  /**
   * Move an object to another key: a copy, then a delete of the source.
   *
   * The delete runs only once the copy has landed, so a failure leaves the
   * original in place rather than losing the object between the two steps.
   */
  async moveObject(
    bucketSlug: string,
    fromKey: string,
    toKey: string,
    scope: FileAccessScope = {},
    options: { upsert?: boolean } = {},
  ) {
    const source = await this.findByKey(bucketSlug, fromKey);
    // Refuse an unauthorized move before creating a destination object.
    await this.assertOwner(source, scope);
    // A move renames the object, so it keeps its owner. A secret-key move must
    // not leave the owner locked out of their own file.
    const result = await this.copyResolved(source, bucketSlug, toKey, scope, options, source.ownerId ?? undefined);
    await this.removeResolved(source, scope);
    return result;
  }

  /**
   * Objects under a prefix, in the Supabase `list()` response shape.
   *
   * Keys are stored bucket-prefixed, so the prefix is applied inside the bucket
   * and stripped on the way out: callers think in the keys they passed to
   * upload, not in physical ones.
   */
  async listObjects(
    bucketSlug: string,
    options: {
      prefix?: string;
      limit?: number;
      offset?: number;
      search?: string;
      sortBy?: { column?: string; order?: 'asc' | 'desc' };
    } = {},
    scope: FileAccessScope = {}
  ) {
    const bucket = await this.di.BucketService.getBySlug(bucketSlug);
    const take = Math.min(Math.max(Number(options.limit) || 100, 1), 1000);
    const skip = Math.max(Number(options.offset) || 0, 0);

    const relativePrefix = options.prefix?.replace(/\/+$/, '');
    const prefix = relativePrefix ? `${bucketSlug}/${normalizeObjectKey(relativePrefix)}` : bucketSlug;
    const where: any = {
      bucketId: bucket.id,
      status: FileStatus.ready,
      key: { startsWith: `${prefix.replace(/\/$/, '')}/` },
    };
    if (options.search) where.key = { ...where.key, contains: options.search };
    // A private bucket lists only what the caller could read anyway, so listing
    // cannot become a way to enumerate other people's objects.
    const policies = Boolean(await this.di.StoragePolicyService?.enabled());
    if (!policies && bucket.visibility !== FileVisibility.public && scope.bucketId !== bucket.id && !scope.caller?.serviceRole) {
      where.ownerId = scope.userId ?? '__no_such_owner__';
    }

    const column = options.sortBy?.column === 'created_at' ? 'createdAt'
      : options.sortBy?.column === 'updated_at' ? 'updatedAt'
      : 'key';
    const order = options.sortBy?.order === 'desc' ? 'desc' : 'asc';

    if (policies && scope.bucketId !== bucket.id && !scope.caller?.serviceRole) {
      const files = await this.di.StoragePolicyService.listVisibleObjects(bucket.id, {
        prefix: `${prefix}/`, search: options.search, take, skip, column, order,
      }, this.callerFor(scope));
      return this.toListShape(files, bucketSlug);
    }

    const files = await this.di.prisma.file.findMany({
      where,
      skip,
      take,
      orderBy: { [column]: order },
    });

    return this.toListShape(files, bucketSlug);
  }

  private toListShape(files: any[], bucketSlug: string) {

    return files.map((file: any) => ({
      // Supabase returns the key relative to the bucket.
      name: String(file.key).slice(bucketSlug.length + 1),
      id: file.id,
      updated_at: file.updatedAt?.toISOString?.() ?? null,
      created_at: file.createdAt?.toISOString?.() ?? null,
      last_accessed_at: null,
      metadata: {
        size: file.size,
        mimetype: file.mime ?? null,
        cacheControl: null,
      },
    }));
  }

  async getDownloadUrl(fileId: string, scope: FileAccessScope = {}, expiresInSec?: number) {
    const file = await this.requireReadyFile(fileId);
    await this.assertReadable(file, scope);
    return this.describeUrl(file, expiresInSec);
  }

  /**
   * Stream a private object after an access-control check. Backs the
   * authenticated `/api/files/:id/raw` route used by the local driver.
   */
  async streamFile(fileId: string, scope: FileAccessScope = {}) {
    const file = await this.requireReadyFile(fileId);
    await this.assertReadable(file, scope);
    const object = await this.driver.getObject(file.bucket, file.key);
    return {
      body: object.body,
      contentLength: object.contentLength,
      mime: file.mime ?? object.contentType ?? 'application/octet-stream',
    };
  }

  async remove(fileId: string, scope: FileAccessScope = {}): Promise<StorageRemoveContract> {
    return this.removeResolved(await this.requireFile(fileId), scope);
  }

  private async removeResolved(file: any, scope: FileAccessScope): Promise<StorageRemoveContract> {
    await this.assertOwner(file, scope);
    logActivity('info', 'storage', `[storage] delete ${file.bucket}/${file.key}`);
    await this.driver.delete(file.bucket, file.key);
    await this.di.prisma.file.delete({ where: { id: file.id } });
    if (file.bucketId && file.status === FileStatus.ready) {
      void this.di.BucketService.dispatchWebhook(file.bucketId, 'file.deleted', { id: file.id, key: file.key });
    }
    return { deleted: true };
  }

  // --- Admin (Studio storage browser): no owner checks, ADMIN-gated at route. ---

  /**
   * Paginated, filtered file listing with the owner's email, for the storage
   * browser.
   *
   * `q`, `category` and `visibility` are applied here rather than in the
   * browser: filtering a page that was already cut to 25 rows silently hides
   * every older object, and the console then reports "no files" for one that
   * exists. `totalSize` is the size of everything the filter matches, not of
   * the page, for the same reason.
   */
  async listFiles(
    filters: FileListFilters & { bucketSlug?: string } = {}
  ): Promise<FileListPage> {
    const { page, take, skip } = filePage(filters);

    let bucketFilter: { bucketId?: string } = {};
    if (filters.bucketSlug) {
      const b = await this.di.BucketService.getBySlug(filters.bucketSlug);
      bucketFilter = { bucketId: b.id };
    }

    const where = buildFileWhere(bucketFilter, filters);
    const [files, total, sizes] = await Promise.all([
      this.di.prisma.file.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: { owner: { select: { id: true, email: true } } },
      }),
      this.di.prisma.file.count({ where }),
      this.di.prisma.file.aggregate({ where, _sum: { size: true } }),
    ]);
    const rows = (files as any[]).map(({ owner, ...rest }) => ({
      ...rest,
      ownerEmail: owner?.email ?? null,
    }));
    return { rows, total, page, pageSize: take, totalSize: Number(sizes._sum.size ?? 0) };
  }

  /** Download URL for any file, bypassing owner checks (admin only). */
  async adminGetDownloadUrl(fileId: string) {
    const file = await this.requireReadyFile(fileId);
    if (file.visibility === FileVisibility.public) {
      return file.url ?? this.driver.publicUrl(file.bucket, file.key);
    }
    // Local private objects aren't statically served; stream them through the
    // admin-gated raw endpoint instead of leaking a public URL.
    if (this.isLocal) return `${this.baseHost()}/api/admin/storage/files/${file.id}/raw`;
    return this.driver.getSignedDownloadUrl(file.bucket, file.key, DOWNLOAD_URL_TTL);
  }

  /** Stream any file without owner checks. Admin-gated at the route. */
  async adminStreamFile(fileId: string) {
    const file = await this.requireReadyFile(fileId);
    const object = await this.driver.getObject(file.bucket, file.key);
    return {
      body: object.body,
      contentLength: object.contentLength,
      mime: file.mime ?? object.contentType ?? 'application/octet-stream',
    };
  }

  /** Upload a file from Studio, bypassing owner checks (admin only). */
  async adminUpload(input: Omit<UploadInput, 'ownerId'>) {
    return this.upload({ ...input, scope: { caller: { serviceRole: true } } });
  }

  /** Delete any file, bypassing owner checks (admin only). */
  async adminRemove(fileId: string) {
    const file = await this.requireFile(fileId);
    await this.driver.delete(file.bucket, file.key);
    await this.di.prisma.file.delete({ where: { id: file.id } });
    if (file.bucketId && file.status === FileStatus.ready) {
      void this.di.BucketService.dispatchWebhook(file.bucketId, 'file.deleted', { id: file.id, key: file.key });
    }
    return { deleted: true };
  }

  private async requireFile(fileId: string): Promise<FileModel> {
    const file = await this.di.prisma.file.findUnique({ where: { id: fileId } });
    if (!file) throw new HttpException('File not found', 404);
    return file;
  }

  private async requireReadyFile(fileId: string): Promise<FileModel> {
    const file = await this.requireFile(fileId);
    if (file.status !== FileStatus.ready) throw new HttpException('File not found', 404);
    return file;
  }

  /**
   * True when the scope carries a claim over this specific file. Both branches
   * require a positive match: an absent claim never grants access.
   *
   * Note the `File.ownerId` column is nullable (bucket-token uploads have no
   * owner, and deleting a user nulls it via onDelete: SetNull), so owner
   * identity alone cannot be the gate: an ownerless private object is reachable
   * only through the bucket that contains it.
   */
  private hasClaim(file: StorageObjectRef, scope: FileAccessScope): boolean {
    if (scope.bucketId && file.bucketId === scope.bucketId) return true;
    if (scope.userId && file.ownerId === scope.userId) return true;
    return false;
  }

  /**
   * Two authorization models, and which one runs is the operator's choice.
   *
   * Off (the default): the built-in rule, public-or-owner, exactly as it has
   * always behaved. On: PostgreSQL policies on `storage.files` decide, so the
   * same policies a Supabase project already has can be ported over.
   *
   * The flag is read per call rather than cached, because it changes from Studio
   * and an authorization decision must never be made against a stale copy of the
   * rule that governs it.
   */
  private callerFor(scope: FileAccessScope): RlsUser | undefined {
    return scope.caller ?? (scope.userId ? { id: scope.userId } : undefined);
  }

  private async assertReadable(file: FileModel, scope: FileAccessScope) {
    if (scope.caller?.serviceRole) return;
    // Optional on purpose: an internal caller assembled with a partial container
    // (schedulers, cleanup) must fall back to the built-in rule rather than
    // crash the authorization path. Absent means "built-in", never "allowed".
    if (await this.di.StoragePolicyService?.enabled()) {
      // A bucket token is a pre-authorized grant on one bucket, issued by an
      // operator. It is checked before policies for the same reason a signed URL
      // is: the authorization already happened, at issue time.
      if (scope.bucketId && file.bucketId === scope.bucketId) return;
      if (await this.di.StoragePolicyService.canRead(file as StorageObjectRef, this.callerFor(scope))) return;
      return this.denied('read', file, scope);
    }
    if (file.visibility === FileVisibility.public) return;
    if (this.hasClaim(file, scope)) return;
    this.denied('read', file, scope);
  }

  /**
   * The single write-authorization path: insert, update and delete all land
   * here, so upload, presign, copy, move and remove cannot drift apart on who
   * is allowed to do what. Policies off keeps the built-in rule exactly as it
   * was: a caller may create objects, and may change or delete only what its
   * claim covers.
   */
  private async assertWritable(
    action: 'insert' | 'update' | 'delete',
    object: StorageObjectRef,
    scope: FileAccessScope,
  ) {
    if (scope.caller?.serviceRole) return;
    if (await this.di.StoragePolicyService?.enabled()) {
      // A bucket token is a pre-authorized grant on one bucket, checked before
      // policies for the same reason a signed URL is: the authorization already
      // happened, at issue time.
      if (scope.bucketId && object.bucketId === scope.bucketId) return;
      if (await this.di.StoragePolicyService.canWrite(action, object, this.callerFor(scope))) return;
      return this.denied('write', object, scope);
    }
    if (action === 'insert') return;
    if (this.hasClaim(object, scope)) return;
    this.denied('write', object, scope);
  }

  private async assertOwner(file: FileModel, scope: FileAccessScope) {
    await this.assertWritable('delete', file as StorageObjectRef, scope);
  }

  /**
   * A 403 here is either a misconfigured client or someone probing other
   * tenants' keys. The request logger records the status but not which object
   * was refused, which is the part that matters when reading it back.
   */
  private denied(action: 'read' | 'write', file: StorageObjectRef & { bucket?: string }, scope: FileAccessScope): never {
    logActivity(
      'warn',
      'storage',
      `[storage] denied ${action} ${file.bucket ? `${file.bucket}/` : ''}${file.key}${scope.userId ? ` user=${scope.userId}` : ''}`
    );
    throw new HttpException('Forbidden', 403);
  }
}
