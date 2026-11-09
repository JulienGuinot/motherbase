import { useMemo, useState } from 'react';
import type { RlsTable } from '@/features/database/lib/rls-api';

import { tableStatus, type TableStatus } from '@/features/database/lib/rls-table-status';
import { SidebarHeader } from '@/shared/ui/SidebarHeader';


const DOT_COLOR: Record<TableStatus, string> = {
  enforced: 'var(--green)',
  locked: 'var(--text-mute)',
  exposed: 'var(--text-mute)',
};

export function RlsTableList({
  tables,
  selected,
  onSelect,
}: {
  tables: RlsTable[];
  selected: string | null;
  onSelect: (table: string) => void;
}) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return tables;
    return tables.filter(t => t.table.toLowerCase().includes(needle));
  }, [tables, q]);

  return (
    <aside className="flex h-[220px] w-full shrink-0 flex-col overflow-hidden border-b hairline md:h-auto md:w-60 md:border-b-0 md:border-r" style={{ background: 'var(--ink-2)' }}>
      <SidebarHeader title="Tables">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search tables…"
          aria-label="Search tables"
          className="input w-full text-[12px]"
        />
      </SidebarHeader>
      <div className="flex-1 overflow-auto py-1">
        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-[11px]" style={{ color: 'var(--paper-mute)' }}>No tables match.</p>
        ) : (
          filtered.map(t => {
            const status = tableStatus(t);
            const isSel = t.table === selected;
            return (
              <button
                key={t.table}
                onClick={() => onSelect(t.table)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-[var(--ink-3)]"
                style={{
                  background: isSel ? 'var(--ink-3)' : 'transparent',
                  borderLeft: `2px solid ${isSel ? 'var(--accent)' : 'transparent'}`,
                }}
              >
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0"
                  style={{ borderRadius: 999, background: DOT_COLOR[status] }}
                  role="img"
                  aria-label={`RLS ${status}`}
                  title={status}
                />
                <span className="truncate font-medium">{t.table}</span>
                <span className="ml-auto text-[10px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
                  {t.policies.length}
                </span>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
