'use client';

import Sparkline from '@/shared/ui/Sparkline';
import { EmptyState } from '@/shared/ui/EmptyState';
import SupabaseLogo from '@/shared/ui/SupabaseLogo';
import { ArrowUpRight } from 'lucide-react';

interface SourceBreakdown {
  name: string;
  total: number;
  errors: number;
  warns: number;
  buckets: number[];
}

interface LogLine {
  id: string | number;
  at: string;
  level: string;
  source: string;
  message: string;
}

/** Offered on an empty project: the fastest way to end up with something in it. */
export function SupabaseImportOffer({ onImport }: { onImport: () => void }) {
  return (
    <section className="card flex flex-wrap items-center gap-4 p-5">
      <SupabaseLogo size={30} />
      <div className="min-w-0 flex-1">
        <div className="text-[14px]" style={{ color: 'var(--text)', fontWeight: 600 }}>
          Coming from Supabase?
        </div>
        <div className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
          This project is empty. Import your schema, data, RLS policies and auth users from an existing Supabase
          project.
        </div>
      </div>
      <button className="btn btn-primary" onClick={onImport}>
        <SupabaseLogo size={14} /> Import from Supabase
      </button>
    </section>
  );
}

/**
 * Requests in the last hour, and the log lines observed alongside them. Kept
 * apart: log lines mix job, SQL, auth and HTTP output, so a success rate over
 * them would score a project that logged nothing at a confident 100%. Requests
 * come from the request telemetry.
 */
export function RequestActivityPanel({
  events,
  successRate,
  logLines,
  sources,
}: {
  /** Undefined until the telemetry has been read. */
  events: number | undefined;
  /** Null when the window carried no requests: there is no rate to report. */
  successRate: number | null | undefined;
  logLines: number;
  sources: SourceBreakdown[];
}) {
  const rateColor =
    successRate == null
      ? 'var(--text-mute)'
      : successRate >= 99
        ? 'var(--green)'
        : successRate >= 90
          ? 'var(--amber)'
          : 'var(--red)';

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        {/* Wraps: four figures in one row ran off the right of a 320px screen,
            and the last of them is the log count. */}
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span
            className="text-[26px] tabular-nums"
            style={{ color: 'var(--text)', fontWeight: 600, letterSpacing: '-0.01em' }}
          >
            {events === undefined ? '—' : events.toLocaleString()}
          </span>
          <span className="text-[13px]" style={{ color: 'var(--text-mute)' }}>
            requests
          </span>
          <span className="text-[26px] tabular-nums" style={{ color: rateColor, fontWeight: 600 }}>
            {successRate === undefined ? '—' : successRate === null ? 'n/a' : `${successRate}%`}
          </span>
          <span className="text-[13px]" style={{ color: 'var(--text-mute)' }}>
            {successRate === null ? 'no traffic yet' : 'success rate'}
          </span>
          <span className="text-[13px]" style={{ color: 'var(--text-mute)' }}>
            · {logLines.toLocaleString()} log {logLines === 1 ? 'line' : 'lines'}
          </span>
        </div>
        <span className="chip">Last 60 minutes</span>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {sources.map(source => (
          <div key={source.name} className="rounded-lg border hairline p-3" style={{ background: 'var(--surface-1)' }}>
            <div className="flex items-center justify-between">
              <span className="mono truncate text-[12px]" style={{ color: 'var(--text-dim)' }}>
                {source.name}
              </span>
              <div className="flex items-center gap-2 text-[10px]">
                <span style={{ color: 'var(--amber)' }}>{source.warns} warn</span>
                <span style={{ color: source.errors > 0 ? 'var(--red)' : 'var(--text-mute)' }}>
                  {source.errors} err
                </span>
              </div>
            </div>
            <div className="mt-1 text-[20px] tabular-nums" style={{ fontWeight: 600 }}>
              {source.total.toLocaleString()}
            </div>
            <div className="mt-2">
              <Sparkline values={source.buckets} width={260} height={40} />
            </div>
          </div>
        ))}

        {sources.length === 0 && (
          <EmptyState
            className="col-span-full"
            mascot="presenting-chart"
            title="No request activity yet. Once your services emit logs, per-source charts appear here."
          />
        )}
      </div>
    </section>
  );
}

/** The tail of the log buffer, newest first. */
export function RecentActivityPanel({ logs, onOpenLogs }: { logs: LogLine[]; onOpenLogs: () => void }) {
  const recent = logs.slice(-8).reverse();

  return (
    <section className="card">
      <div className="flex items-center justify-between border-b hairline p-5">
        <h2 className="display-heading text-[15px]">Recent activity</h2>
        <button onClick={onOpenLogs} className="btn btn-ghost">
          All logs <ArrowUpRight size={12} />
        </button>
      </div>

      <ul>
        {recent.map((line, index) => (
          <li
            key={line.id}
            className="flex items-center gap-4 px-5 py-2.5 text-[12px]"
            style={index === 0 ? undefined : { borderTop: '1px solid var(--hairline)' }}
          >
            <span className="tabular-nums" style={{ color: 'var(--text-mute)' }}>
              {new Date(line.at).toLocaleTimeString()}
            </span>
            <span
              className={`dot ${line.level === 'error' ? 'dot-err' : line.level === 'warn' ? 'dot-warn' : 'dot-info'}`}
            />
            <span className="w-16" style={{ color: 'var(--text-mute)' }}>
              {line.level}
            </span>
            <span className="mono shrink-0" style={{ color: 'var(--text-dim)' }}>
              {line.source}
            </span>
            <span className="truncate" style={{ color: 'var(--text-dim)' }}>
              {line.message}
            </span>
          </li>
        ))}

        {logs.length === 0 && (
          <EmptyState as="li" title="No log activity yet" description="Requests, errors and job runs appear here once your services start emitting." />
        )}
      </ul>
    </section>
  );
}
