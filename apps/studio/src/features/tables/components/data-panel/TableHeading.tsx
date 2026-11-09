import { Plus, ShieldCheck, Terminal } from 'lucide-react';
import type { TableMeta } from '@/features/tables/components/table.types';

function RowCount({ total, estimated, loaded, loading }: { total: number | undefined; estimated: boolean; loaded: boolean; loading: boolean }) {
  if (loaded) {
    return (
      <span title={estimated ? 'Planner estimate: this table is large enough that an exact count would scan it in full.' : undefined}>
        {estimated ? '~' : ''}{total?.toLocaleString() ?? 0} rows
      </span>
    );
  }
  return loading ? <span style={{ opacity: 0.6 }}>counting…</span> : <>—</>;
}

/** Identity and the actions that change the table, nothing else. */
export function TableHeading({
  activeModel,
  meta,
  total,
  totalEstimated,
  loaded,
  loading,
  readOnly,
  onOpenSql,
  onOpenPermissions,
  onNewRow,
}: {
  activeModel: string | undefined;
  meta: TableMeta | undefined;
  total: number | undefined;
  totalEstimated: boolean;
  loaded: boolean;
  loading: boolean;
  readOnly: boolean;
  onOpenSql: () => void;
  onOpenPermissions: () => void;
  onNewRow: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b hairline px-4 pb-3 pt-5">
      <div className="min-w-0">
        <h2 className="text-[16px] leading-none" style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>{meta?.dbName ?? activeModel ?? 'Select a table'}</h2>
        {meta && (
          <p className="mt-1 text-[11px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
            model: <span className="mono">{meta.model}</span> · pk: <span className="mono">{meta.primaryKey}</span> · {meta.fields.length} columns ·{' '}
            <RowCount total={total} estimated={totalEstimated} loaded={loaded} loading={loading} />
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button disabled={!meta} onClick={onOpenSql} className="btn btn-ghost" title="Query this table in the SQL editor"><Terminal size={14} /> SQL</button>
        <button disabled={!meta} onClick={onOpenPermissions} className="btn btn-ghost" title="Row level security for this table"><ShieldCheck size={14} /> Permissions</button>
        {!readOnly && <button disabled={!meta} onClick={onNewRow} className="btn btn-primary"><Plus size={14} /> New row</button>}
      </div>
    </div>
  );
}
