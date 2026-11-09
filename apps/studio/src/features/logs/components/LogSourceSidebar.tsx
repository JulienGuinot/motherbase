'use client';

import { Code2, Layers, Search, Star } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ContentItem } from '@/shared/lib/content';
import { LOG_SOURCES_BY_SERVICE } from '@/features/logs/lib/log-sources';

/** What the explorer shows: a source's stream, or the SQL query mode. */
export type LogSelection = { mode: 'stream'; service: string | null } | { mode: 'query'; savedId: string | null };

function Item({ active, onClick, icon, title, children }: {
  active: boolean;
  onClick: () => void;
  icon?: ReactNode;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-current={active ? 'page' : undefined}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--hover)]"
      style={{ color: active ? 'var(--text)' : 'var(--text-dim)', background: active ? 'var(--surface-2)' : undefined, fontWeight: active ? 500 : 400 }}
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  );
}

/** The Logs & Analytics sidebar: sources first, then the query mode and saved queries. */
export function LogSourceSidebar({
  selection,
  savedQueries,
  onSelect,
}: {
  selection: LogSelection;
  savedQueries: ContentItem<'log_sql'>[];
  onSelect: (selection: LogSelection) => void;
}) {
  const isStream = (service: string | null) => selection.mode === 'stream' && selection.service === service;
  const isQuery = (savedId: string | null) => selection.mode === 'query' && selection.savedId === savedId;

  return (
    <aside className="card w-full shrink-0 overflow-hidden py-2 lg:w-56">
      <p className="label px-3 pb-1 pt-1">Sources</p>
      <Item active={isStream(null)} onClick={() => onSelect({ mode: 'stream', service: null })} icon={<Layers size={13} />}>
        All logs
      </Item>
      {LOG_SOURCES_BY_SERVICE.map(source => (
        <Item
          key={source.id}
          active={isStream(source.id)}
          title={source.description}
          onClick={() => onSelect({ mode: 'stream', service: source.id })}
        >
          <span className="ml-[21px]">{source.label}</span>
        </Item>
      ))}

      <p className="label mt-3 border-t px-3 pb-1 pt-3 hairline">Queries</p>
      <Item active={isQuery(null)} onClick={() => onSelect({ mode: 'query', savedId: null })} icon={<Code2 size={13} />}>
        Logs Explorer
      </Item>
      {savedQueries.map(query => (
        <Item
          key={query.id}
          active={isQuery(query.id)}
          title={query.description ?? undefined}
          onClick={() => onSelect({ mode: 'query', savedId: query.id })}
          icon={query.favorite ? <Star size={13} /> : <Search size={13} />}
        >
          {query.name}
        </Item>
      ))}
    </aside>
  );
}
