import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ChevronDown, ChevronUp, RefreshCw, Search, XCircle } from 'lucide-react';
import { platform, type PlatformAuditEvent } from '@/shared/lib/api';
import { auditEventSearchText } from './audit-search';
import { EmptyState } from '@/shared/ui/EmptyState';
import Select from '@/shared/ui/Select';
import { CodeBlock } from '@/shared/ui/CodeBlock';

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function AuditLogTab() {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | 'success' | 'failed'>('all');
  const auditQuery = useQuery({
    queryKey: ['platform-audit', 200],
    queryFn: () => platform.audit(200),
  });

  const events = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (auditQuery.data ?? []).filter(event => {
      if (status === 'success' && !event.success) return false;
      if (status === 'failed' && event.success) return false;
      return !needle || auditEventSearchText(event).includes(needle);
    });
  }, [auditQuery.data, query, status]);

  return (
    <section className="card overflow-hidden" aria-labelledby="audit-log-title">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b hairline px-5 py-4">
        <div>
          <h2 id="audit-log-title" className="text-[13px] font-semibold">
            Operator audit log
          </h2>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--text-mute)' }}>
            Persistent history of console changes. Secrets and request bodies are never recorded.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => auditQuery.refetch()}
          disabled={auditQuery.isFetching}
        >
          <RefreshCw size={12} className={auditQuery.isFetching ? 'animate-spin' : undefined} />
          Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-2 border-b hairline px-5 py-3">
        <label className="relative min-w-[240px] flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--text-mute)' }}
          />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="input w-full pl-8"
            placeholder="Search actor, IP, action or target"
            aria-label="Search audit events"
          />
        </label>
        <Select
          value={status}
          onChange={value => setStatus(value as typeof status)}
          ariaLabel="Filter audit status"
          options={[
            { value: 'all', label: 'All outcomes' },
            { value: 'success', label: 'Successful' },
            { value: 'failed', label: 'Failed' },
          ]}
        />
      </div>

      {auditQuery.isLoading ? (
        <div className="space-y-2 p-5">
          <div className="shimmer h-14" />
          <div className="shimmer h-14" />
          <div className="shimmer h-14" />
        </div>
      ) : auditQuery.isError ? (
        <p className="p-5 text-[12px]" style={{ color: 'var(--red)' }}>
          Audit events could not be loaded.
        </p>
      ) : events.length === 0 ? (
        <EmptyState mascot="log-inspector" title={query || status !== 'all' ? 'No events match these filters.' : 'No operator actions recorded yet.'} />
      ) : (
        <div className="divide-y divide-[var(--hairline)]">
          {events.map(event => (
            <AuditEventRow key={event.id} event={event} />
          ))}
        </div>
      )}
    </section>
  );
}

function AuditEventRow({ event }: { event: PlatformAuditEvent }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const StatusIcon = event.success ? CheckCircle2 : XCircle;
  const detail = event.detail && Object.keys(event.detail).length > 0 ? JSON.stringify(event.detail, null, 2) : null;

  return (
    <article className="px-3 py-2 transition-colors hover:bg-black/5 dark:hover:bg-white/5">
      <div
        className="grid grid-cols-4 gap-4 cursor-pointer items-start justify-between"
        onClick={() => setIsExpanded(!isExpanded)}
        role="button"
        tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && setIsExpanded(!isExpanded)}
      >
        <div className="flex gap-2 min-w-0">
          <StatusIcon
            size={14}
            className="mt-0.5 shrink-0"
            style={{ color: event.success ? 'var(--green)' : 'var(--red)' }}
            aria-label={event.success ? 'Successful action' : 'Failed action'}
          />
          <div className="min-w-0">
            <div className="mono truncate text-[12px] font-medium" title={event.action}>
              {event.action}
            </div>
            <div className="mt-1 truncate text-[11px]" style={{ color: 'var(--text-mute)' }} title={event.target}>
              {event.target || 'Platform'}
            </div>
          </div>
        </div>

        <div className="min-w-0 text-right text-[11px]" style={{ color: 'var(--text-dim)' }}>
          <div className="truncate" title={event.actorEmail}>
            {event.actorEmail} as {event.actorRole}
          </div>
          <div className="mt-1">at {formatTimestamp(event.at)}</div>
        </div>

        <div className='flex items-center justify-center'>
          <div className="chip mono mt-1 text-[10px]" title={event.ip}>
            {event.ip}
          </div>
        </div>


        {detail && (
          <div className='flex items-end justify-end'>
            <button
              type="button"
              className="btn btn-ghost self-end p-1"
              aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
            >
              {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
        )}
      </div>

      {isExpanded && detail && (
        <div className="mt-2">
          <CodeBlock value={detail} copyable={false} maxHeight={260} wrap />
        </div>
      )}
    </article>
  );
}
