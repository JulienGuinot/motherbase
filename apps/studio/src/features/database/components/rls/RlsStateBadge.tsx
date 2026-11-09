import { Badge, type Tone } from '@/shared/ui/Badge';
import type { RlsTable } from '@/features/database/lib/rls-api';

export function RlsStateBadge({ table }: { table: RlsTable }) {
  let label: string;
  let tone: Tone;

  if (!table.rlsEnabled) {
    label = 'RLS disabled';
    tone = 'warn';
  } else if (table.policies.length === 0) {
    label = 'No policies';
    tone = 'danger';
  } else {
    label = `${table.policies.length} ${table.policies.length === 1 ? 'policy' : 'policies'}`;
    tone = 'success';
  }

  return <Badge tone={tone} dot>{label}</Badge>;
}
