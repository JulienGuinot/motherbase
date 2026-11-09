'use client';

import { useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { KeyRound, Link2, LayoutGrid } from 'lucide-react';
import { PageHeader } from '@/shared/ui/PageHeader';
import SchemaSelect from '@/shared/ui/SchemaSelect';
import { QueryState } from '@/shared/ui/QueryState';
import { EmptyState } from '@/shared/ui/EmptyState';
import { useSchema } from '@/shared/lib/schema';
import { useSchemaGraph } from '@/features/tables/hooks/useTables';
import type { SchemaGraph } from '@/features/tables/components/table.types';
import { canvasSize, edgePath, ERD, layoutNodes, type Point } from '@/features/database/lib/erd-layout';
import { NewTableButton } from '@/features/tables/components/NewTableButton';

interface Drag {
  id: string;
  pointerX: number;
  pointerY: number;
  origin: Point;
}

/**
 * The canvas itself: cards positioned absolutely over one SVG layer of
 * foreign-key curves. Cards drag by their header; hovering one highlights the
 * relations in and out of it. Keyed by schema by the page, so switching schema
 * starts from a fresh layout instead of carrying dragged positions across.
 */
function ErdCanvas({ graph }: { graph: SchemaGraph }) {
  const auto = useMemo(() => layoutNodes(graph.nodes, graph.edges), [graph]);
  const [moved, setMoved] = useState<Map<string, Point>>(new Map());
  const [drag, setDrag] = useState<Drag | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  const positions = useMemo(() => new Map([...auto, ...moved]), [auto, moved]);
  const byId = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph.nodes]);
  const size = canvasSize(graph.nodes, positions);
  const fkColumns = useMemo(() => new Set(graph.edges.map(edge => `${edge.fromTable}.${edge.fromColumn}`)), [graph.edges]);

  const startDrag = (id: string) => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id, pointerX: event.clientX, pointerY: event.clientY, origin: positions.get(id)! });
  };
  const onDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const next = {
      x: Math.max(0, drag.origin.x + event.clientX - drag.pointerX),
      y: Math.max(0, drag.origin.y + event.clientY - drag.pointerY),
    };
    setMoved(current => new Map(current).set(drag.id, next));
  };

  return (
    <div className="relative min-h-0 flex-1 overflow-auto" style={{ background: 'var(--code-bg)' }}>
      {moved.size > 0 && (
        <button className="btn btn-ghost absolute right-3 top-3 z-10" onClick={() => setMoved(new Map())} style={{ background: 'var(--surface)' }}>
          <LayoutGrid size={12} /> Auto layout
        </button>
      )}
      <div className="relative" style={{ width: size.width, height: size.height }}>
        <svg className="pointer-events-none absolute inset-0" width={size.width} height={size.height} aria-hidden>
          {graph.edges.map(edge => {
            const d = edgePath(edge, byId, positions);
            if (!d) return null;
            const lit = focus === edge.fromTable || focus === edge.toTable;
            return (
              <path
                key={`${edge.constraint}:${edge.fromColumn}`}
                d={d}
                fill="none"
                stroke={lit ? 'var(--accent)' : 'var(--border)'}
                strokeWidth={lit ? 2 : 1.5}
                strokeDasharray={lit ? undefined : '4 3'}
              />
            );
          })}
        </svg>

        {graph.nodes.map(node => {
          const at = positions.get(node.id)!;
          return (
            <div
              key={node.id}
              className="absolute overflow-hidden"
              style={{
                left: at.x,
                top: at.y,
                width: ERD.nodeWidth,
                background: 'var(--surface)',
                border: `1px solid ${focus === node.id ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-sm)',
                boxShadow: drag?.id === node.id ? 'var(--shadow-pop)' : undefined,
                zIndex: drag?.id === node.id ? 2 : 1,
              }}
              onPointerEnter={() => setFocus(node.id)}
              onPointerLeave={() => setFocus(current => (current === node.id ? null : current))}
            >
              <div
                className="mono flex cursor-grab items-center border-b hairline px-3 text-[12px] font-medium active:cursor-grabbing"
                style={{ height: ERD.headerHeight, background: 'var(--surface-2)', touchAction: 'none' }}
                onPointerDown={startDrag(node.id)}
                onPointerMove={onDrag}
                onPointerUp={() => setDrag(null)}
              >
                <span className="truncate">{node.table}</span>
              </div>
              {node.columns.map(column => (
                <div key={column.name} className="flex items-center gap-2 px-3 text-[11.5px]" style={{ height: ERD.rowHeight }}>
                  <span className="w-3 shrink-0" style={{ color: 'var(--text-mute)' }}>
                    {column.isPrimaryKey ? <KeyRound size={11} /> : fkColumns.has(`${node.id}.${column.name}`) ? <Link2 size={11} /> : null}
                  </span>
                  <span className="mono min-w-0 flex-1 truncate">{column.name}</span>
                  <span className="mono shrink-0 truncate" style={{ color: 'var(--text-mute)', maxWidth: 90 }}>
                    {column.type}{column.nullable ? '' : ' !'}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Database > Schema Visualizer: an entity-relationship diagram of one schema. */
export default function SchemaVisualizer() {
  const { schema } = useSchema();
  // The same query (and cache entry) the table editor's Graph tab reads.
  const graphQuery = useSchemaGraph(schema, 'graph');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b hairline px-4 py-3 sm:px-6">
        <PageHeader
          size="sm"
          title="Schema Visualizer"
          subtitle="Tables and their foreign keys. Drag a table by its header to rearrange."
          actions={
            <>
              <SchemaSelect />
              <NewTableButton />
            </>
          }
        />
      </div>
      <QueryState
        query={graphQuery}
        skeletonRows={4}
        skeletonClassName="card m-6 p-4"
        isEmpty={graph => graph.nodes.length === 0}
        empty={<EmptyState size="md" mascot="plug-cable" title={`No tables in ${schema}`} description="Tables you create show up here with their relations." />}
      >
        {graph => <ErdCanvas key={schema} graph={graph} />}
      </QueryState>
    </div>
  );
}
