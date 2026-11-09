import type { PlatformAuditEvent } from '@/shared/lib/api';

export function auditEventSearchText(event: PlatformAuditEvent): string {
  return [
    event.actorEmail,
    event.actorRole,
    event.ip,
    event.action,
    event.target,
    JSON.stringify(event.detail ?? {}),
  ].join(' ').toLowerCase();
}
