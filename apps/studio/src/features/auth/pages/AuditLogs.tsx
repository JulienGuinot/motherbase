'use client';

import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { SubPage } from '@/shared/ui/SubPage';
import { QueryState } from '@/shared/ui/QueryState';
import { EmptyState } from '@/shared/ui/EmptyState';
import { Pager } from '@/shared/ui/Pager';
import Select from '@/shared/ui/Select';
import { auditApi, type AuditLogEntry } from '@/features/auth/api/audit.api';

const DESCRIPTION =
  'Every sign-up, sign-in, sign-out, token refresh, recovery, account change and factor change, stored in auth.audit_log_entries in the Supabase shape. Retention is set in Settings → Data retention.';

/** Studio → Authentication → Audit Logs. */
export default function AuditLogs() {
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);

  const query = useQuery({
    queryKey: ['auth-audit-logs', { action, actor, page, perPage }],
    queryFn: () => auditApi.list({ action, actor, page, perPage }),
    // Safe here, unlike the table grid: the columns never change with the
    // filters, so a previous page shown while the next loads is still correct.
    placeholderData: keepPreviousData,
  });
  const actions = query.data?.actions ?? [];

  const filterBy = (apply: () => void) => {
    apply();
    setPage(1);
  };

  return (
    <SubPage title="Audit Logs" description={DESCRIPTION}>
      <div className="card flex flex-wrap items-center gap-3 p-3">
        <div
          className="flex min-w-[200px] flex-1 items-center gap-2 border hairline-strong px-3 py-1.5"
          style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
        >
          <Search size={12} style={{ color: 'var(--text-mute)' }} />
          <input
            value={actor}
            onChange={e => filterBy(() => setActor(e.target.value))}
            placeholder="Actor email or id"
            aria-label="Filter by actor"
            className="w-full bg-transparent text-[13px] outline-none placeholder:opacity-50"
          />
        </div>
        <div className="w-56">
          <Select
            value={action}
            onChange={v => filterBy(() => setAction(v))}
            options={[{ value: '', label: 'All actions' }, ...actions.map(a => ({ value: a, label: a }))]}
            ariaLabel="Filter by action"
          />
        </div>
      </div>

      <QueryState
        query={query}
        skeletonRows={6}
        skeletonClassName=""
        errorTitle="Could not load audit logs"
        empty={<EmptyState mascot="sleeping" title="No audit events" description="Nothing matches these filters yet." />}
        isEmpty={data => data.entries.length === 0}
      >
        {data => (
          <div className="card overflow-hidden">
            <div className="overflow-auto">
              <table className="console">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>Type</th>
                    <th>IP</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map(entry => (
                    <AuditRow key={entry.id} entry={entry} />
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              page={data.page}
              pageSize={data.perPage}
              total={data.total}
              pageCount={Math.max(1, Math.ceil(data.total / data.perPage))}
              pageSizes={[25, 50, 100]}
              onPageChange={setPage}
              onPageSizeChange={size => filterBy(() => setPerPage(size))}
              label="events"
            />
          </div>
        )}
      </QueryState>
    </SubPage>
  );
}

function AuditRow({ entry }: { entry: AuditLogEntry }) {
  const { payload } = entry;
  const traits = payload.traits && Object.keys(payload.traits).length ? JSON.stringify(payload.traits) : '';
  return (
    <tr>
      <td className="whitespace-nowrap text-[12px]">{entry.created_at ? new Date(entry.created_at).toLocaleString() : '-'}</td>
      <td>
        <span className="chip mono">{payload.action}</span>
      </td>
      <td className="text-[12px]">
        <div className="truncate">{payload.actor_username || '-'}</div>
        <div className="mono truncate text-[11px]" style={{ color: 'var(--text-mute)' }}>
          {payload.actor_id}
        </div>
      </td>
      <td className="text-[12px]" style={{ color: 'var(--text-dim)' }}>{payload.log_type}</td>
      <td className="mono text-[12px]">{entry.ip_address || '-'}</td>
      <td className="mono max-w-[280px] truncate text-[11px]" style={{ color: 'var(--text-mute)' }} title={traits}>
        {traits || '-'}
      </td>
    </tr>
  );
}
