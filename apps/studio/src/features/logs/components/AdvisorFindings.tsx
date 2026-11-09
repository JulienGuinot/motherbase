'use client';

import { CheckCheck, ChevronDown } from 'lucide-react';
import { EmptyState } from '@/shared/ui/EmptyState';
import CopyButton from '@/shared/ui/CopyButton';
import { SkeletonList } from '@/shared/ui/Skeleton';
import { CATEGORY_META, LEVEL_META } from '@/features/logs/lib/advisor-meta';
import type { Finding } from '@/features/logs/types';

/** Show impact immediately; keep remediation available without a wall of code. */
export function AdvisorFindings({ findings, isLoading, categoryLabel }: {
  findings: Finding[];
  isLoading: boolean;
  categoryLabel: string;
}) {
  if (isLoading) return <SkeletonList rows={4} height={100} />;

  if (findings.length === 0) {
    return (
      <div className="card">
        <EmptyState icon={CheckCheck} title="No recommendations in this view"
          description={`${categoryLabel}: the current checks found nothing to flag. Run checks again after changing your configuration.`} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {findings.map((finding, index) => {
        const { color, Icon, label } = LEVEL_META[finding.level];
        return (
          <article key={`${finding.id}-${finding.target}-${index}`} className="card overflow-hidden" >
            <div className="p-4 sm:p-5">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
                <span className="inline-flex items-center gap-1.5 rounded px-2 py-1 font-semibold"
                  style={{ color, background: `color-mix(in srgb, ${color} 10%, var(--surface))` }}>
                  <Icon size={13} />{label}
                </span>
                <span style={{ color: 'var(--text-dim)' }}>{CATEGORY_META[finding.category].label}</span>
                <span className="min-w-0 break-all" style={{ color: 'var(--text-mute)' }}>Affected: <code>{finding.target}</code></span>
              </div>
              <h3 className="text-[15px] font-semibold break-words">{finding.title}</h3>
              <p className="mt-1.5 max-w-[78ch] text-[13px] leading-relaxed break-words" style={{ color: 'var(--text-dim)' }}>
                {finding.detail}
              </p>
            </div>
            <details className="group border-t hairline" open={finding.level === 'critical'}>
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-[12px] font-medium sm:px-5"
                style={{ background: 'var(--surface-2)' }}>
                Recommended action
                <ChevronDown size={14} className="transition-transform group-open:rotate-180" />
              </summary>
              <div className="space-y-3 px-4 py-4 sm:px-5">
                <p className="max-w-[78ch] whitespace-pre-wrap break-words text-[13px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                  {finding.remediation ?? 'Review the affected resource and the finding above to decide whether your configuration needs to change.'}
                </p>
                {finding.remediation && <CopyButton value={finding.remediation} label="Copy recommendation" />}
              </div>
            </details>
          </article>
        );
      })}
    </div>
  );
}
