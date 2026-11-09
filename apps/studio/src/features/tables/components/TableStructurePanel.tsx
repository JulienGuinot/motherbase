import { Database, Edit2, Trash2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import { SkeletonList } from '@/shared/ui/Skeleton';

// The policies tab pulls in a CodeMirror editor. It is one of four tabs and the
// grid opens on `data`, so loading it eagerly put a SQL editor in the bundle of
// the single most-visited page in the console for nothing.
const RlsManager = dynamic(
  () => import('@/features/database/components/rls/RlsManager').then(m => m.RlsManager),
  { ssr: false, loading: () => <SkeletonList rows={4} height={18} className="p-4" /> },
);
import { AddColumnForm } from '@/features/tables/components/AddColumnForm';
import { CreateIndexForm } from '@/features/tables/components/CreateIndexForm';
import type { IndexInfo, SchemaGraph, TabId, TableMeta } from '@/features/tables/components/table.types';
import type { SchemaTable } from '@/shared/types/schema';
import { EmptyState } from '@/shared/ui/EmptyState';

interface TableStructurePanelProps {
  tab: TabId;
  schema: string;
  meta: TableMeta | undefined;
  schemaTable: SchemaTable | null | undefined;
  indexes: IndexInfo[] | undefined;
  graph: SchemaGraph | undefined;
  tables: TableMeta[];
  schemaLoading: boolean;
  indexesLoading: boolean;
  graphLoading: boolean;
  readOnly: boolean;
  onEditColumn: (column: SchemaTable['columns'][number]) => void;
  onDropColumn: (column: SchemaTable['columns'][number]) => void;
  onColumnAdded: () => void;
  onDropIndex: (index: IndexInfo) => void;
  onIndexCreated: () => void;
}

export function TableStructurePanel({
  tab,
  schema,
  meta,
  schemaTable,
  indexes,
  graph,
  tables,
  schemaLoading,
  indexesLoading,
  graphLoading,
  readOnly,
  onEditColumn,
  onDropColumn,
  onColumnAdded,
  onDropIndex,
  onIndexCreated,
}: TableStructurePanelProps) {
  if (tab === 'schema') {
    return (
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        {readOnly && <ReadOnlyLabel />}
        <table className="console w-full">
          <thead><tr><th>Column</th><th>Type</th><th>Nullable</th><th>Default</th><th style={{ width: 92 }} /></tr></thead>
          <tbody>
            {schemaTable?.columns.map(column => (
              <tr key={column.name}>
                <td>
                  <span className="text-[12px]" style={{ fontWeight: 500 }}>{column.name}</span>
                  {column.isPrimaryKey && <span className="chip ml-2" style={{ color: 'var(--accent)', fontSize: 9 }}>PK</span>}
                </td>
                <td><span className="mono text-[11px]" style={{ color: 'var(--text-dim)' }}>{column.type}</span></td>
                <td><span className="chip" style={{ color: 'var(--text-dim)' }}>{column.nullable ? 'Yes' : 'No'}</span></td>
                <td><span className="mono text-[11px]" style={{ color: 'var(--text-mute)' }}>{column.default ?? '-'}</span></td>
                <td>
                  {!readOnly && (
                    <div className="flex gap-1">
                      <button onClick={() => onEditColumn(column)} className="btn btn-ghost" title="Edit column"><Edit2 size={12} /></button>
                      {!column.isPrimaryKey && (
                        <button onClick={() => onDropColumn(column)} className="btn btn-ghost" style={{ color: 'var(--danger)' }} title="Drop column"><Trash2 size={12} /></button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {schemaLoading && <div className="shimmer h-8" />}
        {schemaTable === null && <EmptyState title="No schema metadata" description="Postgres returned nothing for this table. It may have been dropped." />}
        {!readOnly && (
          <AddColumnForm
            tableName={meta?.dbName ?? ''}
            schema={schema}
            onAdded={onColumnAdded}
            fkTargets={tables.map(table => table.dbName).filter(name => name !== meta?.dbName)}
          />
        )}
      </div>
    );
  }

  if (tab === 'indexes') {
    return (
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        {readOnly && <ReadOnlyLabel />}
        <table className="console w-full">
          <thead><tr><th>Name</th><th>Unique</th><th>Definition</th><th style={{ width: 40 }} /></tr></thead>
          <tbody>
            {indexes?.map(index => (
              <tr key={index.name}>
                <td><span className="mono text-[12px]">{index.name}</span></td>
                <td><span className="chip" style={{ color: index.unique ? 'var(--text-dim)' : 'var(--text-mute)' }}>{index.unique ? 'Unique' : '-'}</span></td>
                <td><span className="mono text-[11px]" style={{ color: 'var(--text-dim)' }}>{index.definition}</span></td>
                <td>{!readOnly && <button onClick={() => onDropIndex(index)} className="btn btn-ghost" style={{ color: 'var(--danger)' }} title="Drop index"><Trash2 size={12} /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {indexesLoading && <div className="shimmer h-8" />}
        {!readOnly && (
          <CreateIndexForm tableName={meta?.dbName ?? ''} columns={schemaTable?.columns.map(column => column.name) ?? []} schema={schema} onCreated={onIndexCreated} />
        )}
      </div>
    );
  }

  if (tab === 'graph') return <TableGraph meta={meta} graph={graph} loading={graphLoading} />;

  if (tab === 'policies') {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
        {meta ? <RlsManager key={meta.dbName} table={meta.dbName} /> : <EmptyState mascot="looking-map" title="No table selected" description="Pick one from the list to inspect its columns, indexes and relations." />}
      </div>
    );
  }

  return null;
}

function ReadOnlyLabel() {
  return <span className="label" style={{ fontSize: 10, color: 'var(--paper-mute)' }}>system schema · read-only</span>;
}

interface TableGraphProps {
  meta: TableMeta | undefined;
  graph: SchemaGraph | undefined;
  loading: boolean;
}

function TableGraph({ meta, graph, loading }: TableGraphProps) {
  const relatedNodes = (graph?.nodes ?? []).filter(node => node.table === meta?.dbName || (graph?.edges ?? []).some(edge =>
    (edge.fromTable === meta?.dbName && edge.toTable === node.table) || (edge.toTable === meta?.dbName && edge.fromTable === node.table),
  ));
  const relatedEdges = (graph?.edges ?? []).filter(edge => !meta?.dbName || edge.fromTable === meta.dbName || edge.toTable === meta.dbName);

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
      <div className="grid gap-3 md:grid-cols-3">
        {relatedNodes.map(node => (
          <div key={node.id} className="border hairline p-4" style={{ background: node.table === meta?.dbName ? 'var(--ink-3)' : 'var(--ink-2)' }}>
            <div className="flex items-center gap-2">
              <Database size={13} /><span className="text-[13px]" style={{ fontWeight: 500 }}>{node.table}</span>
              {node.primaryKey && <span className="chip ml-auto">pk: {node.primaryKey}</span>}
            </div>
            <div className="mt-3 flex flex-wrap gap-1">
              {node.columns.slice(0, 10).map(column => <span key={column.name} className="chip" style={{ fontSize: 9 }}>{column.name}</span>)}
              {node.columns.length > 10 && <span className="chip" style={{ fontSize: 9 }}>+{node.columns.length - 10}</span>}
            </div>
          </div>
        ))}
      </div>
      <table className="console w-full">
        <thead><tr><th>From</th><th>To</th><th>Constraint</th></tr></thead>
        <tbody>{relatedEdges.map(edge => (
          <tr key={edge.constraint}>
            <td><span className="mono text-[12px]">{edge.fromTable}.{edge.fromColumn}</span></td>
            <td><span className="mono text-[12px]">{edge.toTable}.{edge.toColumn}</span></td>
            <td><span className="mono text-[11px]" style={{ color: 'var(--text-mute)' }}>{edge.constraint}</span></td>
          </tr>
        ))}</tbody>
      </table>
      {loading && <div className="shimmer h-8" />}
      {graph && graph.edges.length === 0 && <EmptyState title="No relations" description="This table has no foreign keys pointing in or out of it." />}
    </div>
  );
}
