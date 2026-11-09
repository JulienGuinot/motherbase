'use client';

import { ShieldAlert, Zap } from 'lucide-react';
import { StatTile } from '@/shared/ui/StatCard';
import { LEVEL_META, LEVEL_ORDER } from '@/features/logs/lib/advisor-meta';
import type { Level } from '@/features/logs/types';

const SCOPE_LABELS: Record<string, string> = {
  global: 'All requests', auth: 'Sign-in', restRead: 'Data reads', restWrite: 'Data writes', edge: 'Functions',
};

/** Whether edge functions are exposed, and how many are live. */
export function EdgePostureCard({
  publicInvoke,
  secrets,
  enabledFunctions,
}: {
  publicInvoke?: boolean;
  secrets?: boolean;
  enabledFunctions?: number;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2">
        <Zap size={14} style={{ color: 'var(--text-mute)' }} />
        <span className="text-[13px]" style={{ fontWeight: 600 }}>
          Edge function access
        </span>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <StatTile label="Public invocation" value={publicInvoke == null ? 'Unknown' : publicInvoke ? 'Allowed' : 'Disabled'} />
        <StatTile label="Secret access" value={secrets == null ? 'Unknown' : secrets ? 'Allowed' : 'Disabled'} />
        <StatTile label="Active functions" value={enabledFunctions ?? 'Unknown'} />
      </div>
    </div>
  );
}

/** The configured request ceilings, per scope, for the current window. */
export function RateLimitCard({ windowMs, limits }: { windowMs?: number; limits?: Record<string, number> }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2">
        <ShieldAlert size={14} style={{ color: 'var(--text-mute)' }} />
        <span className="text-[13px]" style={{ fontWeight: 600 }}>
          Request limits
        </span>
      </div>
      <p className="mt-1 text-[12px]" style={{ color: 'var(--text-dim)' }}>
        {windowMs == null ? 'Window unavailable' : `Maximum requests per ${windowMs / 1000} seconds, by scope.`}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-3 xl:grid-cols-5">
        {Object.entries(limits ?? {}).map(([scope, value]) => (
          <div
            key={scope}
            className="border hairline px-2 py-2"
            style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
          >
            <div className="text-[16px] tabular-nums" style={{ fontWeight: 600 }}>
              {value}
            </div>
            <div className="mt-1 text-[11px]" style={{ color: 'var(--text-dim)' }}>{SCOPE_LABELS[scope] ?? scope}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** One tile per severity, counting the open findings at that level. */
export function LevelCounts({ counts }: { counts: Record<Level, number> }) {
  return (
    <div className="flex flex-wrap gap-5">
      {LEVEL_ORDER.map(level => {
        const { color, label } = LEVEL_META[level];
        return (
          <div key={level} className="flex items-center gap-3">
            <div>
              <div
                className="text-[22px] leading-none tabular-nums"
                style={{ color, fontWeight: 600, letterSpacing: '-0.01em' }}
              >
                {counts[level]}
              </div>
              <div className="mt-1 text-[12px]" style={{ color: 'var(--text-dim)' }}>{label}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
