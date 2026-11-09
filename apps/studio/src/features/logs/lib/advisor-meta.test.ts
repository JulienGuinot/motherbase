import { describe, expect, it } from 'vitest';
import { selectFindings } from './advisor-meta';
import type { Finding } from '@/features/logs/types';

const findings: Finding[] = [
  { id: 'info', category: 'abuse', level: 'info', title: 'Traffic', target: 'auth', detail: 'Traffic detail' },
  { id: 'warning', category: 'performance', level: 'warning', title: 'Index', target: 'users', detail: 'Index detail' },
  { id: 'critical', category: 'security', level: 'critical', title: 'Access', target: 'posts', detail: 'Access detail' },
];

describe('selectFindings', () => {
  it('shows every category in severity order without reordering the cached report', () => {
    expect(selectFindings(findings, 'all').map(finding => finding.id)).toEqual(['critical', 'warning', 'info']);
    expect(findings.map(finding => finding.id)).toEqual(['info', 'warning', 'critical']);
  });

  it('restricts recommendations to the selected category, including empty categories', () => {
    expect(selectFindings(findings, 'performance')).toEqual([findings[1]]);
    expect(selectFindings(findings, 'operations')).toEqual([]);
  });
});
