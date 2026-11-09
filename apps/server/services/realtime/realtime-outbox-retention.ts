const OUTBOX_RETENTION_LIMITS = {
  minDays: 0,
  maxDays: 3650,
} as const;

export interface RealtimeOutboxRetention {
  completedDays: number;
  failedDays: number;
}

export function parseOutboxRetention(value: unknown): RealtimeOutboxRetention | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const retention = value as Record<string, unknown>;
  const completedDays = Number(retention.completedDays);
  const failedDays = Number(retention.failedDays);
  const isValidDays = (days: number) =>
    Number.isInteger(days) && days >= OUTBOX_RETENTION_LIMITS.minDays && days <= OUTBOX_RETENTION_LIMITS.maxDays;

  return isValidDays(completedDays) && isValidDays(failedDays)
    ? { completedDays, failedDays }
    : null;
}
