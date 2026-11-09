import { getErrorMessage } from '@/shared/lib/errors';
import { useProjectId } from '@/shared/hooks/useRouteParam';
import { useCallback, useEffect, useState } from 'react';

import Link from 'next/link';
import { rlsApi, type RlsTable, type PgPolicy } from '@/features/database/lib/rls-api';
import { RlsTableList } from '@/features/database/components/rls/RlsTableList';
import { RlsTableDetail } from '@/features/database/components/rls/RlsTableDetail';
import dynamic from 'next/dynamic';

// Mounted only while a policy is open for editing; the list behind it needs no
// editor at all.
const PolicyEditor = dynamic(
  () => import('@/features/database/components/rls/PolicyEditor').then(m => m.PolicyEditor),
  { ssr: false },
);
import { EmptyState } from '@/shared/ui/EmptyState';
import { SkeletonList } from '@/shared/ui/Skeleton';

type EditorState = { open: false } | { open: true; initial: PgPolicy | null; template?: string };

// Shared RLS composition: table list (optional) + detail + policy editor panel.
// Used full-width by the Permissions page (all tables) and scoped to a single
// table by the Table Editor's policies tab (`table` set → list hidden).
export function RlsManager({ table, wantTable }: { table?: string; wantTable?: string | null }) {
  const [tables, setTables] = useState<RlsTable[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ open: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const single = Boolean(table);
  const id = useProjectId();

  const load = useCallback(async () => {
    try {
      const next = await rlsApi.listTables();
      setTables(next);
      setSelected(prev => {
        if (single) return next.some(t => t.table === table) ? table! : null;
        if (wantTable && next.some(t => t.table === wantTable)) return wantTable;
        return prev && next.some(t => t.table === prev) ? prev : next[0]?.table ?? null;
      });
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [single, table, wantTable]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const current = tables.find(t => t.table === selected) ?? null;

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden border p-4 hairline md:flex-row" style={{ background: 'var(--ink-1)' }}>
        {!single && (
          <SkeletonList rows={6} height={32} className="w-full shrink-0 md:w-64" />
        )}
        <SkeletonList rows={4} height={64} className="flex-1" />
      </div>
    );
  }
  if (error) return <p className="text-[12px]" style={{ color: 'var(--danger)' }}>Failed to load tables: {error}</p>;
  if (single && !current) {
    return (
      <EmptyState title="RLS metadata unavailable" description="Postgres did not report policy metadata for this table." />
    );
  }
  if (!single && tables.length === 0) {
    return (
      <EmptyState
        className="min-h-0 flex-1 border hairline"
        mascot="shield-keylock"
        title="No tables to secure yet"
        description={<>Row-level security policies apply to tables in the <span className="mono">public</span> schema. Create your first table, then come back to decide who can read and write its rows.</>}
        action={<Link href={`/p/${id}/tables`} className="btn btn-primary">Open Table Editor</Link>}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto border hairline md:flex-row md:overflow-hidden" style={{ background: 'var(--ink-1)' }}>
      {!single && (
        <RlsTableList
          tables={tables}
          selected={selected}
          onSelect={t => { setSelected(t); setEditor({ open: false }); }}
        />
      )}
      {current && (
        <RlsTableDetail
          table={current}
          onChange={load}
          onNewPolicy={templateId => setEditor({ open: true, initial: null, template: templateId })}
          onEditPolicy={p => setEditor({ open: true, initial: p })}
        />
      )}
      {editor.open && current && (
        <PolicyEditor
          key={`${current.table}:${editor.initial?.name ?? editor.template ?? '__new__'}`}
          table={current.table}
          initial={editor.initial}
          initialTemplate={editor.template}
          onClose={() => setEditor({ open: false })}
          onSaved={load}
        />
      )}
    </div>
  );
}
