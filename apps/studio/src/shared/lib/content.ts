import { api } from '@/shared/lib/api';

/**
 * Studio content, persisted by the project (see services/admin/content.service.ts):
 * SQL snippets, saved Logs Explorer queries and custom reports.
 */
export type ContentType = 'sql' | 'log_sql' | 'report';
export type ContentVisibility = 'user' | 'project';

export interface ReportChart {
  id: string;
  /** A key of the report metric catalog (features/logs/lib/report-metrics). */
  metric: string;
  title?: string;
  chart: 'line' | 'bar';
}

export interface ContentPayloads {
  sql: { sql: string };
  log_sql: { sql: string };
  report: { charts: ReportChart[]; range?: string };
}

export interface ContentItem<T extends ContentType = ContentType> {
  id: string;
  type: T;
  name: string;
  description: string | null;
  content: ContentPayloads[T];
  visibility: ContentVisibility;
  ownerId: string;
  folderId: string | null;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ContentFolder {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
}

export interface ContentDraft<T extends ContentType> {
  name: string;
  description?: string | null;
  content: ContentPayloads[T];
  visibility?: ContentVisibility;
  folderId?: string | null;
  favorite?: boolean;
}

export type ContentPatch<T extends ContentType> = Partial<ContentDraft<T>>;

export const contentApi = {
  /** Items visible to the caller, plus who the server says the caller is. */
  list: <T extends ContentType>(type: T) =>
    api
      .get('/admin/content', { params: { type } })
      .then(r => r.data.data as { items: ContentItem<T>[]; operator: string }),
  create: <T extends ContentType>(type: T, draft: ContentDraft<T>) =>
    api.post('/admin/content', { type, ...draft }).then(r => r.data.data.item as ContentItem<T>),
  update: <T extends ContentType>(id: string, patch: ContentPatch<T>) =>
    api.patch(`/admin/content/${id}`, patch).then(r => r.data.data.item as ContentItem<T>),
  remove: (id: string) => api.delete(`/admin/content/${id}`),
  folders: () => api.get('/admin/content-folders').then(r => r.data.data.folders as ContentFolder[]),
  createFolder: (name: string) => api.post('/admin/content-folders', { name }).then(r => r.data.data.folder as ContentFolder),
  renameFolder: (id: string, name: string) => api.patch(`/admin/content-folders/${id}`, { name }),
  removeFolder: (id: string) => api.delete(`/admin/content-folders/${id}`),
};
