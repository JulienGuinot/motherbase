import { Activity, AlertOctagon, AlertTriangle, Ban, Gauge, Info, ShieldAlert } from 'lucide-react';
import type { Category, Finding, Level } from '@/features/logs/types';

type IconType = React.ComponentType<{ size?: number; style?: React.CSSProperties }>;

export const LEVEL_META: Record<Level, { color: string; Icon: IconType; label: string }> = {
  critical: { color: 'var(--danger)', Icon: AlertOctagon, label: 'Critical' },
  warning: { color: 'var(--amber)', Icon: AlertTriangle, label: 'Warning' },
  info: { color: 'var(--text-mute)', Icon: Info, label: 'Info' },
};

export const CATEGORY_META: Record<Category, { Icon: IconType; label: string }> = {
  security: { Icon: ShieldAlert, label: 'Security' },
  performance: { Icon: Gauge, label: 'Performance' },
  abuse: { Icon: Ban, label: 'Abuse' },
  operations: { Icon: Activity, label: 'Operations' },
};

/** Most severe first, which is the order findings are listed in. */
export const LEVEL_ORDER: Level[] = ['critical', 'warning', 'info'];

export const CATEGORIES: Category[] = ['security', 'performance', 'abuse', 'operations'];

export type AdvisorCategory = Category | 'all';

/** Keep the most urgent recommendations first, without mutating cached data. */
export function selectFindings(findings: Finding[], category: AdvisorCategory): Finding[] {
  return findings
    .filter(finding => category === 'all' || finding.category === category)
    .sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
}
