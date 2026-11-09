'use client';

import { useMemo, useReducer } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { PageShell } from '@/shared/ui/PageHeader';
import { useContextMenu } from '@/shared/hooks/useContextMenu';
import { LogContextMenu } from '@/features/logs/components/LogContextMenu';
import { LogField } from '@/features/logs/components/LogField';
import { LogStream } from '@/features/logs/components/LogStream';
import { LogStreamHeader } from '@/features/logs/components/LogStreamHeader';
import { LogToolbar } from '@/features/logs/components/LogToolbar';
import { useLogStream } from '@/features/logs/hooks/useLogStream';
import { LOG_SOURCES, type LogFacet } from '@/features/logs/lib/log-stream';
import { baseLogColumns, useLogColumns, type LogColumn } from '@/features/logs/lib/columns';
import { FLEET_RANGE_MS } from '@/shared/lib/range';
import { FLEET_CONSOLE_SCOPE, useFleetLogs, type FleetLogEntry } from '@/features/platform/hooks/useFleetLogs';

const FACETS: LogFacet<FleetLogEntry>[] = [
  { key: 'scope', label: 'project', of: entry => entry.scope },
  { key: 'source', label: 'source', of: entry => entry.source, values: LOG_SOURCES },
];

/** Projects whose buffer could not be read, and the console's own gate. */
function CollectionNotice({ unreachable, consoleDenied }: { unreachable: string[]; consoleDenied: boolean }) {
  if (unreachable.length === 0 && !consoleDenied) return null;

  return (
    <div className="card flex items-start gap-2 p-3 text-[12px]" style={{ color: 'var(--amber)' }}>
      <AlertTriangle size={13} style={{ marginTop: 1, flexShrink: 0 }} />
      <div>
        {unreachable.length > 0 && (
          <p>
            No answer from {unreachable.join(', ')}. The container may be starting, or its API is unreachable through
            the proxy.
          </p>
        )}
        {consoleDenied && <p>Console-level lines are hidden: they need the owner or admin role.</p>}
      </div>
    </div>
  );
}

// Org > Logs: every project's log buffer plus the console's own, in one stream.
export default function Logs() {
  const qc = useQueryClient();
  const menu = useContextMenu<FleetLogEntry>();

  const [paused, togglePaused] = useReducer(current => !current, false);
  const fleet = useFleetLogs(paused);
  const entries = useMemo(() => fleet.data?.entries ?? [], [fleet.data]);

  // The owning project is a column like any other, so it gets a caption and can
  // be turned off, instead of being a nameless cell wedged into every row.
  const columns = useLogColumns<FleetLogEntry>(
    'platform.logColumns',
    useMemo(() => {
      const base = baseLogColumns<FleetLogEntry>();
      const project: LogColumn<FleetLogEntry> = {
        key: 'project',
        label: 'project',
        width: 'w-[120px]',
        defaultOn: true,
        render: entry => (
          <span
            className="w-[120px] shrink-0 truncate"
            style={{ color: entry.scope === FLEET_CONSOLE_SCOPE ? 'var(--text-mute)' : 'var(--accent)' }}
            title={entry.scope}
          >
            {entry.scope}
          </span>
        ),
      };
      const at = base.findIndex(column => column.key === 'source');
      return [...base.slice(0, at), project, ...base.slice(at)];
    }, [])
  );

  const stream = useLogStream<FleetLogEntry>({
    entries,
    updatedAt: fleet.dataUpdatedAt,
    facets: FACETS,
    search: entry => [entry.message, entry.source, entry.scope],
    paused,
    onTogglePaused: togglePaused,
  });

  const projectCount = fleet.running.length;

  return (
    <PageShell width="wide">
      <LogStreamHeader
        paused={stream.paused}
        shown={stream.filtered.length}
        total={stream.windowed.length}
        range={stream.range}
        description={`Console activity merged with every running project's buffer, across ${projectCount} project${
          projectCount === 1 ? '' : 's'
        }. Auto-refresh every 5s.`}
        counts={stream.counts}
        levelBuckets={stream.levelBuckets}
      />

      <CollectionNotice unreachable={fleet.data?.unreachable ?? []} consoleDenied={fleet.data?.consoleDenied ?? false} />

      <LogToolbar
        stream={stream}
        facets={FACETS}
        columns={columns}
        ranges={FLEET_RANGE_MS}
        exportName={`fleet-logs-${fleet.dataUpdatedAt || 'export'}`}
        onRefresh={() => qc.invalidateQueries({ queryKey: ['fleet-logs'] })}
      />

      <LogStream
        entries={stream.filtered}
        isLoading={(fleet.isLoading || fleet.projectsLoading) && stream.filtered.length === 0}
        keyOf={entry => entry.key}
        emptyTitle={projectCount === 0 ? 'No running project to collect logs from.' : undefined}
        columns={columns.visible}
        onContextMenu={menu.onContextMenu}
        renderDetailFields={entry => <LogField label="Project" value={entry.scope} />}
        renderDetailFooter={entry =>
          entry.scope !== FLEET_CONSOLE_SCOPE && (
            <Link href={`/p/${encodeURIComponent(entry.scope)}/logs`} className="btn btn-ghost mt-3">
              Open {entry.scope} logs
            </Link>
          )
        }
      />

      {menu.menu && (
        <LogContextMenu
          x={menu.menu.x}
          y={menu.menu.y}
          entry={menu.menu.data}
          entryId={menu.menu.data.key}
          hasFilters={stream.hasFilters}
          facetActions={[
            {
              label: `Filter by project: ${menu.menu.data.scope}`,
              run: () => stream.toggleFacet('scope', menu.menu!.data.scope),
            },
            {
              label: `Filter by source: ${menu.menu.data.source}`,
              run: () => stream.toggleFacet('source', menu.menu!.data.source),
            },
          ]}
          onClose={menu.close}
          onFilterLevel={() => stream.toggleLevel(menu.menu!.data.level)}
          onClearFilters={stream.clearAll}
        />
      )}
    </PageShell>
  );
}
