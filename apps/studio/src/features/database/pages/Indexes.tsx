'use client';

import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import SchemaSelect from '@/shared/ui/SchemaSelect';
import Select from '@/shared/ui/Select';
import { QueryState } from '@/shared/ui/QueryState';
import { EmptyState } from '@/shared/ui/EmptyState';
import { Badge } from '@/shared/ui/Badge';
import { WriteButton } from '@/shared/ui/WriteButton';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { useSchema } from '@/shared/lib/schema';
import { formatBytes } from '@/shared/lib/format';
import { useSchemaTables } from '@/features/sql/hooks/useSchemaTables';
import { catalogApi, type SchemaIndex } from '@/features/database/api/catalog.api';
import { useCatalogWrite, useSchemaIndexes } from '@/features/database/hooks/useCatalog';
import { CreateIndexModal, type IndexDraft } from '@/features/database/components/CreateIndexModal';

const ALL_TABLES = '';

/** Database > Indexes: every index of a schema, with how it is built and what it costs. */
export default function Indexes() {
  const { schema } = useSchema();
  const indexesQuery = useSchemaIndexes(schema);
  const tablesQuery = useSchemaTables(schema);
  const [table, setTable] = useState(ALL_TABLES);
  const [creating, setCreating] = useState(false);

  const create = useCatalogWrite({
    run: (draft: IndexDraft) =>
      catalogApi.createIndex(schema, draft.table, {
        columns: draft.columns,
        unique: draft.unique,
        method: draft.method,
        ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
      }),
    invalidate: 'schema.changed',
    success: 'Index created',
    failTitle: 'Create failed',
    onSuccess: () => setCreating(false),
  });

  const drop = useCatalogWrite({
    run: (index: SchemaIndex) => catalogApi.dropIndex(schema, index.name),
    invalidate: 'schema.changed',
    success: index => `Dropped ${index.name}`,
    failTitle: 'Drop failed',
  });

  const confirmDrop = async (index: SchemaIndex) => {
    const ok = await confirmDialog({
      title: `Drop index "${index.name}"?`,
      description: index.unique
        ? `On ${index.table}. It also stops enforcing uniqueness on ${index.columns.join(', ')}.`
        : `On ${index.table}. Queries that relied on it fall back to scanning the table.`,
      confirmLabel: 'Drop index',
      tone: 'danger',
    });
    if (ok) drop.mutate(index);
  };

  const tableNames = useMemo(() => [...new Set((indexesQuery.data ?? []).map(index => index.table))], [indexesQuery.data]);

  return (
    <PageShell width="wide">
      <PageHeader
        title="Indexes"
        subtitle="Speed up lookups, joins and sorting. Every index also costs a little on each write."
        actions={
          <>
            <Select
              value={table}
              onChange={setTable}
              ariaLabel="Filter by table"
              label="table"
              options={[{ value: ALL_TABLES, label: 'All tables' }, ...tableNames.map(name => ({ value: name, label: name }))]}
            />
            <SchemaSelect />
            <WriteButton className="btn btn-primary" onClick={() => setCreating(true)} disabled={!tablesQuery.data?.length}>
              <Plus size={12} /> Create index
            </WriteButton>
          </>
        }
      />

      <QueryState
        query={indexesQuery}
        skeletonRows={6}
        empty={
          <div className="card">
            <EmptyState size="md" mascot="plug-cable" title={`No indexes in ${schema}`} description="Primary keys and unique constraints create indexes automatically; add your own for the columns you filter on." />
          </div>
        }
      >
        {indexes => (
          <div className="card overflow-x-auto p-0">
            <table className="console">
              <thead>
                <tr>
                  <th>Table</th>
                  <th>Name</th>
                  <th>Columns</th>
                  <th>Method</th>
                  <th className="text-right">Size</th>
                  <th>Definition</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {indexes.filter(index => !table || index.table === table).map(index => (
                  <tr key={index.name}>
                    <td className="mono text-[12px]">{index.table}</td>
                    <td>
                      <span className="mono text-[12px]">{index.name}</span>
                      {index.primary ? <Badge tone="info" className="ml-2">primary</Badge> : index.unique ? <Badge className="ml-2">unique</Badge> : null}
                    </td>
                    <td className="mono text-[12px]">{index.columns.join(', ')}</td>
                    <td><Badge>{index.method}</Badge></td>
                    <td className="text-right tabular-nums">{formatBytes(index.sizeBytes)}</td>
                    <td className="mono max-w-[36ch] truncate text-[11px]" style={{ color: 'var(--text-mute)' }} title={index.definition}>
                      {index.definition}
                    </td>
                    <td className="text-right">
                      {/* A primary key's index belongs to its constraint: DROP INDEX refuses it. */}
                      {!index.primary && (
                        <WriteButton className="btn btn-ghost" style={{ color: 'var(--danger)' }} title="Drop index" onClick={() => confirmDrop(index)}>
                          <Trash2 size={12} />
                        </WriteButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryState>

      {creating && tablesQuery.data && (
        <CreateIndexModal
          schema={schema}
          tables={tablesQuery.data}
          saving={create.isPending}
          onSave={draft => create.mutate(draft)}
          onClose={() => setCreating(false)}
        />
      )}
    </PageShell>
  );
}
