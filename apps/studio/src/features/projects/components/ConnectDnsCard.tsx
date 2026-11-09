'use client';

import { CheckCircle2, XCircle } from 'lucide-react';
import type { DnsCheck } from '@/shared/lib/api';

/** DNS records this project needs, and whether each one resolves. */
export function ConnectDnsCard({ checks }: { checks: DnsCheck[] }) {
  if (checks.length === 0) return null;
  const allOk = checks.every(check => check.ok);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {allOk ? (
            <CheckCircle2 size={14} style={{ color: 'var(--green)' }} />
          ) : (
            <XCircle size={14} style={{ color: 'var(--danger)' }} />
          )}
          <span className="text-[13px]" style={{ fontWeight: 600 }}>
            DNS checks
          </span>
        </div>
        <span className="chip" style={{ color: allOk ? 'var(--green)' : 'var(--danger)' }}>
          {allOk ? 'Ready' : 'Fix DNS'}
        </span>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-3">
        {checks.map(check => (
          <div
            key={`${check.name}-${check.target}`}
            className="border hairline p-3"
            style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
          >
            <div className="flex items-center gap-2 text-[12px]">
              {check.ok ? (
                <CheckCircle2 size={12} style={{ color: 'var(--green)' }} />
              ) : (
                <XCircle size={12} style={{ color: 'var(--danger)' }} />
              )}
              <span>{check.name}</span>
            </div>
            <div className="mono mt-1 truncate text-[11px]" title={check.target} style={{ color: 'var(--text-mute)' }}>
              {check.target}
            </div>
            <div className="mt-1 text-[11px]" style={{ color: check.ok ? 'var(--green)' : 'var(--danger)' }}>
              {check.message}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
