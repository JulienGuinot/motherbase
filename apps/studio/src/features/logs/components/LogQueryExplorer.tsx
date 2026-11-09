'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import CodeMirror from '@uiw/react-codemirror';
import { sql as sqlLang } from '@codemirror/lang-sql';
import { Play, Save, Share2, Star, Trash2 } from 'lucide-react';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { useCodeMirrorTheme, overlayTooltips } from '@/shared/lib/codemirror-theme';
import { confirmDialog, promptDialog } from '@/shared/ui/ConfirmDialog';
import { EmptyState } from '@/shared/ui/EmptyState';
import { Cell } from '@/features/sql/components/Cell';
import { logsApi } from '@/features/logs/api/logs.api';
import { LOG_QUERY_TEMPLATES } from '@/features/logs/lib/log-sources';
import type { useContent } from '@/shared/hooks/useContent';
import type { ContentItem } from '@/shared/lib/content';

type SavedQueries = ReturnType<typeof useContent<'log_sql'>>;

/**
 * Query mode of the Logs Explorer: read-only SQL over the stored history in
 * `platform.request_logs`, with Supabase's starting templates and saved
 * queries. Runs through /admin/sql/readonly, so a query can read but never
 * write, whatever it says.
 */
export function LogQueryExplorer({
  saved,
  queries,
  persisted,
  onSaved,
}: {
  /** The saved query to open, or null for a scratch query. */
  saved: ContentItem<'log_sql'> | null;
  queries: SavedQueries;
  /** False while log storage is off, when the table holds nothing to query. */
  persisted: boolean;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const theme = useCodeMirrorTheme();
  const [sql, setSql] = useState(saved?.content.sql ?? LOG_QUERY_TEMPLATES[0].sql);
  const run = useMutation({ mutationFn: (text: string) => logsApi.runQuery(text) });
  const mine = saved !== null && saved.ownerId === queries.operator;

  const save = async () => {
    if (saved && mine) {
      queries.update.mutate({ id: saved.id, patch: { content: { sql } } });
      toast.push({ kind: 'success', title: 'Query saved', message: saved.name });
      return;
    }
    const name = await promptDialog({ title: 'Save query', placeholder: 'Slow auth requests', confirmLabel: 'Save query' });
    if (!name) return;
    queries.create.mutate({ name, content: { sql } }, {
      onSuccess: item => {
        toast.push({ kind: 'success', title: 'Query saved', message: item.name });
        onSaved(item.id);
      },
    });
  };

  const remove = async () => {
    if (!saved) return;
    const confirmed = await confirmDialog({ title: `Delete "${saved.name}"?`, confirmLabel: 'Delete query', tone: 'danger' });
    if (confirmed) queries.remove.mutate(saved.id);
  };

  const result = run.data;
  const columns = result?.columns ?? [];

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      {!persisted && (
        <div className="card p-3 text-[12px]" style={{ color: 'var(--amber)' }}>
          Log storage is off, so platform.request_logs is empty. Turn it on under Retention to query history.
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 hairline">
          <span className="text-[13px]" style={{ fontWeight: 600 }}>{saved?.name ?? 'New query'}</span>
          {saved?.visibility === 'project' && <span className="chip text-[10px]">shared</span>}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {mine && (
              <>
                <button className="btn btn-ghost" title={saved.favorite ? 'Unfavorite' : 'Favorite'}
                  onClick={() => queries.update.mutate({ id: saved.id, patch: { favorite: !saved.favorite } })}>
                  <Star size={12} fill={saved.favorite ? 'currentColor' : 'none'} />
                </button>
                <button className="btn btn-ghost" title="Share with the project"
                  onClick={() => queries.update.mutate({ id: saved.id, patch: { visibility: saved.visibility === 'project' ? 'user' : 'project' } })}>
                  <Share2 size={12} /> {saved.visibility === 'project' ? 'Unshare' : 'Share'}
                </button>
                <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={remove} title="Delete query">
                  <Trash2 size={12} />
                </button>
              </>
            )}
            <button className="btn" onClick={save}><Save size={12} /> {mine ? 'Save' : 'Save as'}</button>
            <button className="btn btn-primary" disabled={run.isPending || !sql.trim()} onClick={() => run.mutate(sql)}>
              <Play size={12} /> {run.isPending ? 'Running…' : 'Run'}
            </button>
          </div>
        </div>
        <CodeMirror value={sql} onChange={setSql} theme={theme} extensions={[sqlLang(), overlayTooltips]} height="200px" />
        <div className="flex flex-wrap gap-2 border-t px-3 py-2 hairline">
          <span className="label self-center">Templates</span>
          {LOG_QUERY_TEMPLATES.map(template => (
            <button key={template.id} className="chip" title={template.description} onClick={() => setSql(template.sql)}>
              {template.label}
            </button>
          ))}
        </div>
      </div>

      <div className="card min-h-[200px] overflow-auto">
        {run.isError ? (
          <p className="mono p-4 text-[12px]" style={{ color: 'var(--danger)' }}>{getErrorMessage(run.error)}</p>
        ) : !result ? (
          <EmptyState title="Run a query" description="Results from the stored log history appear here." />
        ) : (result.rows?.length ?? 0) === 0 ? (
          <EmptyState title="No rows" description="The query ran and matched nothing." />
        ) : (
          <table className="console" style={{ width: 'max-content', minWidth: '100%' }}>
            <thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead>
            <tbody>
              {result.rows!.map((row, index) => (
                <tr key={index}>{columns.map(column => <td key={column} className="max-w-md truncate"><Cell v={row[column]} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
