import type { Request } from 'express';
import type { Prisma, StudioContent, StudioContentFolder } from '@prisma/client';
import { z } from 'zod';
import BaseContext from '../../context/base-context';
import { HttpException } from '../../exceptions/http-exception';

export const CONTENT_TYPES = ['sql', 'log_sql', 'report'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

/** A chart on a custom report: one metric from the Observability catalog. */
const reportChartSchema = z.object({
  id: z.string().min(1).max(64),
  metric: z.string().min(1).max(64),
  title: z.string().max(120).optional(),
  chart: z.enum(['line', 'bar']).default('line'),
});

/** What `content` holds, per type. Validated on every write, never trusted on read. */
const PAYLOAD_SCHEMAS: Record<ContentType, z.ZodTypeAny> = {
  sql: z.object({ sql: z.string().max(200_000) }),
  log_sql: z.object({ sql: z.string().max(50_000) }),
  report: z.object({ charts: z.array(reportChartSchema).max(48), range: z.string().max(8).optional() }),
};

export const contentCreateSchema = z.object({
  type: z.enum(CONTENT_TYPES),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2_000).nullish(),
  content: z.unknown(),
  visibility: z.enum(['user', 'project']).default('user'),
  folderId: z.string().uuid().nullish(),
  favorite: z.boolean().default(false),
});

export const contentUpdateSchema = contentCreateSchema.omit({ type: true }).partial();

export const folderSchema = z.object({ name: z.string().trim().min(1).max(120) });

export type ContentCreate = z.infer<typeof contentCreateSchema>;
export type ContentUpdate = z.infer<typeof contentUpdateSchema>;

/**
 * The operator behind an admin request. Through the console that is the
 * signed-in operator the console names (`adminGuard` reads it next to the
 * platform token); on a direct call with an ADMIN user token, that user.
 */
export function operatorOf(req: Request): string {
  const user = req.user as { id?: string; operatorId?: string } | undefined;
  return user?.operatorId || user?.id || 'admin';
}

function parsePayload(type: ContentType, content: unknown): Prisma.InputJsonValue {
  const parsed = PAYLOAD_SCHEMAS[type].safeParse(content);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpException(`content${issue.path.length ? `.${issue.path.join('.')}` : ''}: ${issue.message}`, 400);
  }
  return parsed.data as Prisma.InputJsonValue;
}

/**
 * Studio content: SQL snippets, saved log queries and custom reports, the
 * three kinds Supabase keeps behind its content API.
 *
 * Visibility follows Supabase's snippets: a `user` item is visible to its
 * owner only, a `project` item to every operator of the project. Only the
 * owner may change or delete either; everyone else reads a shared item and
 * can copy it into their own.
 */
export class ContentService extends BaseContext {
  async list(operator: string, type?: ContentType): Promise<StudioContent[]> {
    return this.di.prisma.studioContent.findMany({
      where: { ...(type ? { type } : {}), OR: [{ ownerId: operator }, { visibility: 'project' }] },
      orderBy: [{ favorite: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  async get(operator: string, id: string): Promise<StudioContent> {
    const item = await this.di.prisma.studioContent.findUnique({ where: { id } });


    
    // A private item of someone else is reported missing, not forbidden: its
    // existence is not the caller's business either.
    if (!item || (item.visibility !== 'project' && item.ownerId !== operator)) {
      throw new HttpException('Content not found', 404);
    }
    return item;
  }

  async create(operator: string, input: ContentCreate): Promise<StudioContent> {
    if (input.folderId) await this.ownFolder(operator, input.folderId);
    return this.di.prisma.studioContent.create({
      data: {
        type: input.type,
        name: input.name,
        description: input.description ?? null,
        content: parsePayload(input.type, input.content),
        visibility: input.visibility,
        folderId: input.folderId ?? null,
        favorite: input.favorite,
        ownerId: operator,
      },
    });
  }

  async update(operator: string, id: string, patch: ContentUpdate): Promise<StudioContent> {
    const item = await this.owned(operator, id);
    if (patch.folderId) await this.ownFolder(operator, patch.folderId);
    return this.di.prisma.studioContent.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.content !== undefined ? { content: parsePayload(item.type as ContentType, patch.content) } : {}),
        ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
        ...(patch.folderId !== undefined ? { folderId: patch.folderId } : {}),
        ...(patch.favorite !== undefined ? { favorite: patch.favorite } : {}),
      },
    });
  }



  
  async remove(operator: string, id: string): Promise<void> {
    await this.owned(operator, id);
    await this.di.prisma.studioContent.delete({ where: { id } });
  }

  listFolders(operator: string): Promise<StudioContentFolder[]> {
    return this.di.prisma.studioContentFolder.findMany({ where: { ownerId: operator }, orderBy: { name: 'asc' } });
  }




  createFolder(operator: string, name: string): Promise<StudioContentFolder> {
    return this.di.prisma.studioContentFolder.create({ data: { name, ownerId: operator } });
  }

  async renameFolder(operator: string, id: string, name: string): Promise<StudioContentFolder> {
    await this.ownFolder(operator, id);
    return this.di.prisma.studioContentFolder.update({ where: { id }, data: { name } });
  }

  /** Its snippets move back to the top level (the foreign key is ON DELETE SET NULL). */
  async removeFolder(operator: string, id: string): Promise<void> {
    await this.ownFolder(operator, id);
    await this.di.prisma.studioContentFolder.delete({ where: { id } });
  }

  private async owned(operator: string, id: string): Promise<StudioContent> {
    const item = await this.get(operator, id);
    if (item.ownerId !== operator) throw new HttpException('Only the owner can change this item', 403);
    return item;
  }

  private async ownFolder(operator: string, id: string): Promise<StudioContentFolder> {
    const folder = await this.di.prisma.studioContentFolder.findUnique({ where: { id } });
    if (!folder || folder.ownerId !== operator) throw new HttpException('Folder not found', 404);
    return folder;
  }
}
