import { api } from '@/shared/lib/api';

/** One `auth.audit_log_entries` row, in Supabase's shape. */
export interface AuditLogEntry {
  id: string;
  created_at: string | null;
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

export interface AuditLogPage {
  entries: AuditLogEntry[];
  page: number;
  perPage: number;
  total: number;
  /** Every action the server writes, for the filter. */
  actions: string[];
}

export interface AuditLogQuery {
  action?: string;
  actor?: string;
  page: number;
  perPage: number;
}

export const auditApi = {
  list: ({ action, actor, page, perPage }: AuditLogQuery) =>
    api
      .get('/admin/auth/audit-logs', {
        params: { action: action || undefined, actor: actor || undefined, page, per_page: perPage },
      })
      .then(r => r.data.data as AuditLogPage),
};
