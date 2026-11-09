import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { FileVisibility, Bucket, BucketToken, BucketCors, BucketWebhook } from '@prisma/client';
import BaseContext from '../../context/base-context';
import IContextContainer from '../../context/icontext-container';
import { HttpException } from '../../exceptions/http-exception';
import { assertSafeUrlShape } from '../../helpers/ssrf.helper';
import { sendWebhook } from '../../helpers/webhook-sender.helper';
import { logActivity } from '../../lib/activity-log';
import { errorMessage } from '../../lib/errors';
import { buildFileWhere, filePage, type FileListFilters } from './file-query';
import type { FileListPage } from './storage.service';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const BCRYPT_ROUNDS = 10;
const MAX_ACTIVE_BUCKET_TOKENS = 50;
const TOKEN_PART_RE = /^[A-Za-z0-9_-]+$/;

export interface BucketStats {
  fileCount: number;
  totalBytes: bigint;
}

export class BucketService extends BaseContext {
  constructor(di: IContextContainer) {
    super(di);
  }

  // ---------------------------------------------------------------------------
  // Bucket CRUD
  // ---------------------------------------------------------------------------

  async create(input: {
    slug: string;
    name: string;
    description?: string;
    visibility?: FileVisibility;
    quotaBytes?: bigint;
    fileSizeLimit?: bigint | null;
    allowedMimeTypes?: string[];
  }): Promise<Bucket> {
    this.validateSlug(input.slug);
    const existing = await this.di.prisma.bucket.findUnique({ where: { slug: input.slug } });
    if (existing) throw new HttpException(`Bucket "${input.slug}" already exists`, 409);

    return this.di.prisma.bucket.create({
      data: {
        slug: input.slug,
        name: input.name,
        description: input.description,
        visibility: input.visibility ?? FileVisibility.private,
        quotaBytes: input.quotaBytes ?? null,
        fileSizeLimit: input.fileSizeLimit ?? null,
        allowedMimeTypes: input.allowedMimeTypes ?? [],
      },
    });
  }

  async list(): Promise<(Bucket & BucketStats)[]> {
    const [buckets, stats] = await Promise.all([
      this.di.prisma.bucket.findMany({ orderBy: { createdAt: 'asc' } }),
      this.di.prisma.file.groupBy({
        by: ['bucketId'],
        _count: { id: true },
        _sum: { size: true },
        where: { bucketId: { not: null } },
      }),
    ]);
    const statsMap = new Map(
      stats.map(s => [s.bucketId!, { fileCount: s._count.id, totalBytes: BigInt(s._sum.size ?? 0) }])
    );
    return buckets.map(b => {
      const s = statsMap.get(b.id) ?? { fileCount: 0, totalBytes: BigInt(0) };
      return { ...b, ...s };
    });
  }

  async getBySlug(slug: string): Promise<Bucket> {
    const bucket = await this.di.prisma.bucket.findUnique({ where: { slug } });
    if (!bucket) throw new HttpException('Bucket not found', 404);
    return bucket;
  }

  async update(
    slug: string,
    patch: {
      name?: string;
      description?: string;
      visibility?: FileVisibility;
      quotaBytes?: bigint | null;
      fileSizeLimit?: bigint | null;
      allowedMimeTypes?: string[];
    }
  ): Promise<Bucket> {
    await this.getBySlug(slug);
    return this.di.prisma.bucket.update({ where: { slug }, data: patch });
  }

  async delete(slug: string, force = false) {
    const bucket = await this.getBySlug(slug);
    if (force) {
      const job = await this.di.BucketDeletionService.enqueue(bucket);
      return { deleted: false as const, job };
    }

    await this.di.prisma.$transaction(async tx => {
      const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT "id" FROM "storage"."buckets" WHERE "id" = $1 FOR UPDATE',
        bucket.id,
      );
      if (!locked.length) throw new HttpException('Bucket not found', 404);
      const fileCount = await tx.file.count({ where: { bucketId: bucket.id } });
      if (fileCount > 0) {
        const noun = fileCount === 1 ? 'file' : 'files';
        throw new HttpException(
          'Bucket has ' + fileCount + ' ' + noun + ', use ?force=true to delete all',
          409,
        );
      }
      await tx.bucket.delete({ where: { id: bucket.id } });
    }, { isolationLevel: 'Serializable' });

    return { deleted: true as const };
  }
  // ---------------------------------------------------------------------------
  // Files in bucket (paginated)
  // ---------------------------------------------------------------------------

  /** Same paging and filter contract as StorageService.listFiles; see it for why. */
  async listFiles(slug: string, filters: FileListFilters = {}): Promise<FileListPage> {
    const bucket = await this.getBySlug(slug);
    const { page, take, skip } = filePage(filters);
    const where = buildFileWhere({ bucketId: bucket.id }, filters);
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

  // ---------------------------------------------------------------------------
  // CORS
  // ---------------------------------------------------------------------------

  async getCors(bucketId: string): Promise<BucketCors | null> {
    return this.di.prisma.bucketCors.findUnique({ where: { bucketId } });
  }

  async upsertCors(
    bucketId: string,
    data: { allowedOrigins: string[]; allowedMethods: string[]; allowedHeaders: string[]; maxAgeSec?: number }
  ): Promise<BucketCors> {
    return this.di.prisma.bucketCors.upsert({
      where: { bucketId },
      create: { bucketId, ...data, maxAgeSec: data.maxAgeSec ?? 3600 },
      update: { ...data },
    });
  }

  async deleteCors(bucketId: string): Promise<void> {
    await this.di.prisma.bucketCors.deleteMany({ where: { bucketId } });
  }

  // ---------------------------------------------------------------------------
  // Tokens
  // ---------------------------------------------------------------------------

  async listTokens(bucketId: string): Promise<(Omit<BucketToken, 'token'> & { needsRotation: boolean })[]> {
    const tokens = await this.di.prisma.bucketToken.findMany({
      where: { bucketId },
      orderBy: { createdAt: 'desc' },
    });
    return tokens.map(({ token: _token, ...rest }) => ({
      ...rest,
      needsRotation: rest.lookupId === null,
    }));
  }

  async createToken(
    bucketId: string,
    input: { name: string; permissions: string[]; expiresAt?: Date }
  ): Promise<{ tokenRecord: Omit<BucketToken, 'token'>; raw: string }> {
    const lookupId = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString('base64url');
    const hashed = await this.hashToken(secret);
    const record = await this.di.prisma.$transaction(async tx => {
      const lockedBucket = await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id FROM "storage"."buckets" WHERE id = $1 FOR UPDATE',
        bucketId,
      );
      if (lockedBucket.length !== 1) throw new HttpException('Bucket not found', 404);

      const activeTokens = await tx.bucketToken.count({
        where: {
          bucketId,
          lookupId: { not: null },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      });
      if (activeTokens >= MAX_ACTIVE_BUCKET_TOKENS) {
        throw new HttpException(`A bucket can have at most ${MAX_ACTIVE_BUCKET_TOKENS} active tokens`, 409);
      }

      return tx.bucketToken.create({
        data: {
          bucketId,
          name: input.name,
          lookupId,
          token: hashed,
          permissions: input.permissions,
          expiresAt: input.expiresAt ?? null,
        },
      });
    });
    const { token: _token, ...tokenRecord } = record;
    return { tokenRecord, raw: `${lookupId}.${secret}` };
  }

  async revokeToken(tokenId: string): Promise<void> {
    const exists = await this.di.prisma.bucketToken.findUnique({ where: { id: tokenId } });
    if (!exists) throw new HttpException('Token not found', 404);
    await this.di.prisma.bucketToken.delete({ where: { id: tokenId } });
  }

  async verifyToken(raw: string, bucketSlug: string, requiredPermission: string): Promise<BucketToken> {
    const parsed = this.parseToken(raw);
    if (!parsed) throw new HttpException('Invalid token', 401);

    const [bucket, token] = await Promise.all([
      this.getBySlug(bucketSlug),
      this.di.prisma.bucketToken.findUnique({ where: { lookupId: parsed.lookupId } }),
    ]);
    if (!token || token.bucketId !== bucket.id) {
      throw new HttpException('Invalid token', 401);
    }

    const match = await this.compareToken(parsed.secret, token.token);
    if (!match) throw new HttpException('Invalid token', 401);
    if (token.expiresAt && token.expiresAt < new Date()) {
      throw new HttpException('Token expired', 401);
    }
    if (!token.permissions.includes(requiredPermission)) {
      throw new HttpException(`Token does not have [${requiredPermission}] permission`, 403);
    }
    return token;
  }

  // ---------------------------------------------------------------------------
  // Webhooks
  // ---------------------------------------------------------------------------

  async listWebhooks(bucketId: string): Promise<BucketWebhook[]> {
    return this.di.prisma.bucketWebhook.findMany({ where: { bucketId }, orderBy: { id: 'asc' } });
  }

  async addWebhook(bucketId: string, input: { url: string; events: string[] }): Promise<BucketWebhook> {
    // Reject http(s)-only / literal-private-IP targets at registration time so a
    // bad URL fails visibly here rather than silently at dispatch. The
    // DNS-resolving check runs at send time (see sendWebhook).
    assertSafeUrlShape(input.url);
    return this.di.prisma.bucketWebhook.create({ data: { bucketId, url: input.url, events: input.events } });
  }

  async removeWebhook(id: string): Promise<void> {
    const exists = await this.di.prisma.bucketWebhook.findUnique({ where: { id } });
    if (!exists) throw new HttpException('Webhook not found', 404);
    await this.di.prisma.bucketWebhook.delete({ where: { id } });
  }

  async dispatchWebhook(bucketId: string | null, event: string, payload: object): Promise<void> {
    if (!bucketId) return;
    let webhooks: BucketWebhook[];
    try {
      webhooks = await this.di.prisma.bucketWebhook.findMany({
        where: { bucketId, events: { has: event } },
      });
    } catch {
      return;
    }

    for (const wh of webhooks) {
      // Go through sendWebhook rather than a raw fetch: it applies the SSRF
      // guard (this URL is operator-supplied but must not be able to reach
      // loopback/metadata/internal container addresses), a timeout, and
      // redirect: 'manual' so a redirect cannot re-enter internal space after
      // the check.
      sendWebhook(this.di.OutboundHttpClient, wh.url, { event, payload, timestamp: new Date().toISOString() }).catch(
        err => logActivity('error', 'webhook', `[BucketWebhook] dispatch failed for ${wh.url}: ${errorMessage(err)}`)
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  protected hashToken(secret: string): Promise<string> {
    return bcrypt.hash(secret, BCRYPT_ROUNDS);
  }

  protected compareToken(secret: string, hash: string): Promise<boolean> {
    return bcrypt.compare(secret, hash);
  }

  private parseToken(raw: string): { lookupId: string; secret: string } | null {
    const parts = String(raw ?? '').split('.');
    if (parts.length !== 2) return null;
    const [lookupId, secret] = parts;
    if (
      lookupId.length < 16 ||
      lookupId.length > 64 ||
      secret.length < 32 ||
      secret.length > 128 ||
      !TOKEN_PART_RE.test(lookupId) ||
      !TOKEN_PART_RE.test(secret)
    ) {
      return null;
    }
    return { lookupId, secret };
  }

  private validateSlug(slug: string): void {
    if (!SLUG_RE.test(slug)) {
      throw new HttpException('Slug must be lowercase alphanumeric and hyphens, 3–63 chars', 400);
    }
  }
}
