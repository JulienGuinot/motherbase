import { Badge, type Tone } from '@/shared/ui/Badge';
import type { MigrationOrigin, MigrationStatus } from '@/features/database/types';

const STATUS_META: Record<MigrationStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'warn' },
  applied: { label: 'Applied', tone: 'success' },
  rolledback: { label: 'Rolled back', tone: 'neutral' },
};

// Local-origin (files: CLI or Git) versus authored on this page, the split
// `motherbase migration list` draws between LOCAL and REMOTE.
const ORIGIN_LABEL: Record<MigrationOrigin, string> = { studio: 'Studio', cli: 'CLI', git: 'Git' };

export function OriginBadge({ origin }: { origin: MigrationOrigin }) {
  return <Badge tone={origin === 'studio' ? 'neutral' : 'info'}>{ORIGIN_LABEL[origin] ?? origin}</Badge>;
}

export function StatusBadge({ status }: { status: MigrationStatus }) {
  const meta = STATUS_META[status];
  return <Badge tone={meta.tone} dot>{meta.label}</Badge>;
}
