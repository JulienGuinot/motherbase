import type { RlsTable } from '@/features/database/lib/rls-api';

export type TableStatus = 'enforced' | 'locked' | 'exposed';

export function tableStatus(table: RlsTable): TableStatus {
  if (!table.rlsEnabled) return 'exposed';
  return table.policies.length > 0 ? 'enforced' : 'locked';
}
