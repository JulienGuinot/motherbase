'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Search, ShieldCheck, ShieldOff } from 'lucide-react';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import SchemaSelect from '@/shared/ui/SchemaSelect';
import { QueryState } from '@/shared/ui/QueryState';
import { EmptyState } from '@/shared/ui/EmptyState';
import { Badge } from '@/shared/ui/Badge';
import { useSchema } from '@/shared/lib/schema';
import { projectPath } from '@/shared/lib/project';
import { formatBytes } from '@/shared/lib/format';
import { useTables } from '@/features/tables/hooks/useTables';
import { useTableStats } from '@/features/database/hooks/useCatalog';
import { NewTableButton } from '@/features/tables/components/NewTableButton';

/** `reltuples` is -1 until the first ANALYZE: "unknown", not zero rows. */
function rowLabel(estimate: number): string {
  return estimate < 0 ? 'Not analyzed' : `~${estimate.toLocaleString()}`;
}

/**
 * Database > Tables: every relation of a schema with its size on disk,
 * estimated rows and RLS state, one click from the table editor.
 */
export default function DatabaseTables() {
  const { schema } = useSchema();
  const statsQuery = useTableStats(schema);
  const editorTables = useTables();
  const [query, setQuery] = useState('');

  // The editor addresses a table by model id, which is not always its name
  // (`reporting.daily_signups`, a Prisma model): resolve it from the same list
  // the editor reads.
  const editorModel = useMemo(() => {
    const byName = new Map<string, string>();
    for (const meta of editorTables.data ?? []) if (meta.schema === schema) byName.set(meta.dbName, meta.model);
    return byName;
  }, [editorTables.data, schema]);

  const needle = query.trim().toLowerCase();
  const filter = <T extends { name: string }>(rows: T[]) => (needle ? rows.filter(row => row.name.toLowerCase().includes(needle)) : rows);

  return (
    <PageShell width="wide">
      <PageHeader
        title="Tables"
        subtitle="Every table and view in the schema, with its size and row estimate."
        actions={
          <>
            <div className="flex w-[min(240px,50vw)] items-center gap-2 border hairline-strong px-3 py-1.5" style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
              <Search size={12} style={{ color: 'var(--text-mute)' }} />
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Filter tables…"
                aria-label="Filter tables"
                className="w-full bg-transparent text-[13px] outline-none placeholder:opacity-50"
              />
            </div>
            <SchemaSelect />
            <NewTableButton />
          </>
        }
      />

      <QueryState
        query={statsQuery}
        skeletonRows={6}
        empty={
          <div className="card">
            <EmptyState size="md" mascot="plug-cable" title={`No tables in ${schema}`} description="Create one with New table, or from the SQL Editor." />
          </div>
        }
      >
        {tables => (
          <div className="card overflow-x-auto p-0">
            <table className="console">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th className="text-right">Columns</th>
                  <th className="text-right">Rows</th>
                  <th className="text-right">Size</th>
                  <th>RLS</th>
                  <th aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {filter(tables).map(table => {
                  const model = editorModel.get(table.name);
                  return (
                    <tr key={table.name}>
                      <td>
                        <div className="mono text-[12.5px]">{table.name}</div>
                        {table.comment && (
                          <div className="truncate text-[11px]" style={{ color: 'var(--text-mute)', maxWidth: '40ch' }} title={table.comment}>
                            {table.comment}
                          </div>
                        )}
                      </td>
                      <td><Badge>{table.kind}</Badge></td>
                      <td className="text-right tabular-nums">{table.columns}</td>
                      <td className="text-right tabular-nums" style={{ color: table.rowsEstimate < 0 ? 'var(--text-mute)' : undefined }}>
                        {rowLabel(table.rowsEstimate)}
                      </td>
                      <td className="text-right tabular-nums">{formatBytes(table.totalBytes)}</td>
                      <td>
                        {table.kind === 'view' ? null : table.rlsEnabled
                          ? <Badge tone="success"><ShieldCheck size={11} /> Enabled</Badge>
                          : <Badge tone="warn"><ShieldOff size={11} /> Disabled</Badge>}
                      </td>
                      <td className="text-right">
                        {model && (
                          <Link
                            href={projectPath(`/tables/${encodeURIComponent(model)}`)}
                            className="btn btn-ghost"
                            title="Open in the Table Editor"
                          >
                            <ExternalLink size={12} /> Open
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {needle && filter(tables).length === 0 && (
              <p className="px-5 py-4 text-[12px]" style={{ color: 'var(--text-mute)' }}>Nothing matches “{query}”.</p>
            )}
          </div>
        )}
      </QueryState>
    </PageShell>
  );
}
