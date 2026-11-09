import { Prisma } from '@prisma/client';
import BaseContext from '../../context/base-context';
import type { AuditEvent } from '../../auth/audit-actions';

/** GoTrue's actor for changes made with the service key; kept for parity. */
export const SERVICE_ROLE_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

export interface AuditRecordInput {
  event: AuditEvent;
  actorId?: string | null;
  /** GoTrue records the actor's email here. */
  actorUsername?: string | null;
  actorViaSso?: boolean;
  traits?: Record<string, unknown>;
  ipAddress?: string | null;
}

export interface AuditListQuery {
  action?: string;
  logType?: string;
  /** Matches actor id or actor username (email), substring. */
  actor?: string;
  from?: Date;
  to?: Date;
  page?: number;
  perPage?: number;
}

export interface AuditLogRow {
  id: string;
  created_at: Date | null;
  ip_address: string;
  payload: {
    action: string;
    actor_id: string;
    actor_username: string;
    actor_via_sso: boolean;
    log_type: string;
    traits?: Record<string, unknown>;
  };
}

/**
 * Supabase's `auth.audit_log_entries`: one row per auth event, payload in the
 * GoTrue shape. Written fire-and-forget from the auth request hook and from
 * UserAdminService, so a failed insert can never fail the sign-in it describes.
 */
export class AuthAuditService extends BaseContext {
  async record(input: AuditRecordInput): Promise<void> {
    const payload = {
      action: input.event.action,
      actor_id: input.actorId ?? '',
      actor_username: input.actorUsername ?? '',
      actor_via_sso: !!input.actorViaSso,
      log_type: input.event.logType,
      ...(input.event.traits || input.traits ? { traits: { ...input.event.traits, ...input.traits } } : {}),
    };
    await this.di.prisma.authAuditLogEntry.create({
      data: { payload: payload as Prisma.InputJsonObject, ipAddress: (input.ipAddress ?? '').slice(0, 64) },
    });
  }

  /** Same as record(), for callers that must not wait on or fail with it. */
  recordInBackground(input: AuditRecordInput): void {
    void this.record(input).catch(() => {});
  }

  /** Newest first, filtered on the payload fields the Studio page exposes. */
  async list(query: AuditListQuery = {}): Promise<{ entries: AuditLogRow[]; page: number; perPage: number; total: number }> {
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const perPage = Math.min(500, Math.max(1, Math.floor(Number(query.perPage) || 50)));
    const where: Prisma.Sql[] = [];
    if (query.action) where.push(Prisma.sql`payload->>'action' = ${query.action}`);
    if (query.logType) where.push(Prisma.sql`payload->>'log_type' = ${query.logType}`);
    if (query.actor) {
      const like = `%${query.actor.replace(/[\\%_]/g, c => `\\${c}`)}%`;
      where.push(Prisma.sql`(payload->>'actor_id' ILIKE ${like} OR payload->>'actor_username' ILIKE ${like})`);
    }
    if (query.from) where.push(Prisma.sql`created_at >= ${query.from}`);
    if (query.to) where.push(Prisma.sql`created_at <= ${query.to}`);
    const filter = where.length ? Prisma.sql`WHERE ${Prisma.join(where, ' AND ')}` : Prisma.empty;

    const [rows, counted] = await Promise.all([
      this.di.prisma.$queryRaw<Array<{ id: string; created_at: Date | null; ip_address: string; payload: AuditLogRow['payload'] }>>(Prisma.sql`
        SELECT id::text, created_at, ip_address, payload
        FROM auth.audit_log_entries
        ${filter}
        ORDER BY created_at DESC NULLS LAST, id
        LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
      `),
      this.di.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT count(*)::int AS count FROM auth.audit_log_entries ${filter}
      `),
    ]);
    return { entries: rows, page, perPage, total: counted[0]?.count ?? 0 };
  }

  /** One ordered retention batch, the shape DataRetentionService drives. */
  async deleteBatch(cutoff: Date, batchSize: number): Promise<number> {
    const rows = await this.di.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH candidates AS (
        SELECT id FROM auth.audit_log_entries
        WHERE created_at < ${cutoff}
        ORDER BY created_at, id
        LIMIT ${batchSize}
      )
      DELETE FROM auth.audit_log_entries AS entries
      USING candidates
      WHERE entries.id = candidates.id
      RETURNING entries.id
    `);
    return rows.length;
  }
}
