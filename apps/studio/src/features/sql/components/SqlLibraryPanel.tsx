import type { MouseEvent } from 'react';
import { BookMarked, Clock, Copy, FolderPlus, History, Star, Trash2, X } from 'lucide-react';
import { PaneTab } from '@/features/sql/components/PaneTab';
import type { Snippet, SnippetSection } from '@/features/sql/lib/snippets';
import type { ContentFolder } from '@/shared/lib/content';
import type { SqlHistoryEntry, SqlTemplate } from '@/features/sql/types';
import { useCopy } from '@/shared/hooks/useCopy';
import { EmptyState } from '@/shared/ui/EmptyState';

interface SqlLibraryPanelProps {
  mobileOpen: boolean;
  pane: 'snippets' | 'history';
  sections: SnippetSection[];
  snippetCount: number;
  templates: SqlTemplate[];
  /** Who the server says the caller is: only their own snippets can be starred. */
  operator: string | null;
  history: SqlHistoryEntry[];
  onPaneChange: (pane: 'snippets' | 'history') => void;
  onCloseMobile: () => void;
  onOpenQuery: (sql: string) => void;
  onOpenSnippet: (snippet: Snippet) => void;
  onToggleFavorite: (snippet: Snippet) => void;
  onNewFolder: () => void;
  onSnippetContextMenu: (event: MouseEvent, snippet: Snippet) => void;
  onFolderContextMenu: (event: MouseEvent, folder: ContentFolder) => void;
  onHistoryContextMenu: (event: MouseEvent, entry: SqlHistoryEntry) => void;
  onClearHistory: () => void;
}

export function SqlLibraryPanel({
  mobileOpen,
  pane,
  sections,
  snippetCount,
  templates,
  operator,
  history,
  onPaneChange,
  onCloseMobile,
  onOpenQuery,
  onOpenSnippet,
  onToggleFavorite,
  onNewFolder,
  onSnippetContextMenu,
  onFolderContextMenu,
  onHistoryContextMenu,
  onClearHistory,
}: SqlLibraryPanelProps) {
  const copy = useCopy();
  return (
    <aside
      className={`${mobileOpen ? 'fixed inset-x-2 bottom-[calc(64px+env(safe-area-inset-bottom))] top-16 z-50 flex rounded-lg border shadow-xl' : 'hidden'} w-auto shrink-0 flex-col overflow-hidden hairline lg:static lg:flex lg:w-[240px] lg:rounded-none lg:border-0 lg:border-r lg:shadow-none`}
      style={{ background: 'var(--ink-2)' }}
    >
      <div className="flex border-b hairline pt-5">
        <PaneTab active={pane === 'snippets'} onClick={() => onPaneChange('snippets')} icon={BookMarked} label="Snippets" count={snippetCount} />
        <PaneTab active={pane === 'history'} onClick={() => onPaneChange('history')} icon={History} label="History" count={history.length} />
        <button onClick={onCloseMobile} className="btn btn-ghost mx-1 lg:hidden" aria-label="Close panel"><X size={14} /></button>
      </div>
      <div className="flex-1 overflow-auto">
        {pane === 'snippets' ? (
          <div>
            {sections.map(section => (
              <section key={section.key}>
                <h3
                  className="label flex items-center justify-between border-b px-3 py-1.5 hairline"
                  onContextMenu={section.folder ? event => onFolderContextMenu(event, section.folder!) : undefined}
                >
                  {section.label}
                </h3>
                <ul>
                  {section.snippets.map(snippet => (
                    <li key={snippet.id} className="row-host border-b hairline" onContextMenu={event => onSnippetContextMenu(event, snippet)}>
                      <button onClick={() => onOpenSnippet(snippet)} className="block w-full px-3 py-2.5 text-left">
                        <div className="flex items-center gap-2 text-[12px] font-medium">
                          <span className="truncate">{snippet.name}</span>
                          {snippet.visibility === 'project' && <span className="chip text-[10px]">shared</span>}
                        </div>
                        <div className="mt-1 mono truncate text-[10px]" style={{ color: 'var(--paper-mute)' }}>{snippet.content.sql.replace(/\s+/g, ' ').slice(0, 60)}</div>
                      </button>
                      {snippet.ownerId === operator && (
                        <div className="row-actions flex justify-end gap-1 px-2 pb-2">
                          <button onClick={() => onToggleFavorite(snippet)} className="btn btn-ghost" aria-label={`${snippet.favorite ? 'Unfavorite' : 'Favorite'} ${snippet.name}`}>
                            <Star size={11} fill={snippet.favorite ? 'currentColor' : 'none'} />
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {snippetCount === 0 && <EmptyState title="No snippets yet" description="Save a query you re-use and it lands here." />}
            <section>
              <h3 className="label border-b px-3 py-1.5 hairline">Templates</h3>
              <ul>
                {templates.map(template => (
                  <li key={template.id} className="row-host border-b hairline">
                    <button onClick={() => onOpenQuery(template.sql)} className="block w-full px-3 py-2.5 text-left">
                      <div className="text-[12px] font-medium">{template.title}</div>
                      <div className="mt-1 mono truncate text-[10px]" style={{ color: 'var(--paper-mute)' }}>{template.sql.replace(/\s+/g, ' ').slice(0, 60)}</div>
                    </button>
                    <div className="row-actions flex justify-end gap-1 px-2 pb-2">
                      <button onClick={() => copy(template.sql, 'Copied')} className="btn btn-ghost" aria-label={`Copy ${template.title}`}><Copy size={11} /></button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        ) : (
          <ul>
            {history.map(entry => (
              <li key={entry.id} className="border-b hairline" onContextMenu={event => onHistoryContextMenu(event, entry)}>
                <button onClick={() => onOpenQuery(entry.sql)} className="block w-full px-3 py-2 text-left">
                  <div className="flex items-center gap-2 text-[10px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
                    <Clock size={10} />
                    <span>{new Date(entry.at).toLocaleTimeString()}</span>
                    {entry.durationMs != null && <span>· {entry.durationMs}ms</span>}
                    {entry.rows != null && <span>· {entry.rows} rows</span>}
                  </div>
                  <div className="mt-1 mono truncate text-[11px]">{entry.sql.replace(/\s+/g, ' ').slice(0, 80)}</div>
                </button>
              </li>
            ))}
            {history.length === 0 && <EmptyState title="No history yet" description="Every query you run is kept here for the session." />}
          </ul>
        )}
      </div>
      {pane === 'snippets' && (
        <button onClick={onNewFolder} className="btn btn-ghost border-t hairline"><FolderPlus size={11} /> New folder</button>
      )}
      {pane === 'history' && history.length > 0 && (
        <button onClick={onClearHistory} className="btn btn-ghost border-t hairline"><Trash2 size={11} /> Clear history</button>
      )}
    </aside>
  );
}
