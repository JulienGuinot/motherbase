'use client';

import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { useProjectPersistentState } from '@/shared/hooks/usePersistentState';
import { useContent, useContentFolders } from '@/shared/hooks/useContent';
import { confirmDialog, promptDialog } from '@/shared/ui/ConfirmDialog';
import { invalidateAfterArbitrarySql } from '@/shared/lib/invalidate';
import { sqlApi } from '@/features/sql/api/sql.api';
import { formatSql } from '@/features/sql/lib/format-sql';
import {
  DEFAULT_SQL,
  HISTORY_LIMIT,
  SQL_STORAGE_KEYS,
  dropQueryParam,
  newTab,
  queryFromUrl,
  uid,
} from '@/features/sql/lib/workspace';
import type { Snippet } from '@/features/sql/lib/snippets';
import type { SqlHistoryEntry, SqlTab } from '@/features/sql/types';

/**
 * Tabs and history for the SQL editor (kept in this browser), snippets (kept
 * by the project, private or shared), plus the run
 * mutation that feeds results back into the active tab.
 */
export function useSqlWorkspace() {
  const qc = useQueryClient();
  const toast = useToast();

  const [tabs, setTabs] = useProjectPersistentState<SqlTab[]>(SQL_STORAGE_KEYS.tabs, () => [
    { id: uid(), title: 'Query 1', sql: DEFAULT_SQL },
  ]);
  const [activeId, setActiveId] = useProjectPersistentState<string>(SQL_STORAGE_KEYS.active, () => tabs[0]?.id ?? '');
  const [history, setHistory] = useProjectPersistentState<SqlHistoryEntry[]>(SQL_STORAGE_KEYS.history, []);
  const library = useContent('sql');
  const { folders, create: createFolder, rename: renameFolder, remove: removeFolder } = useContentFolders();

  const active = tabs.find(t => t.id === activeId) ?? tabs[0];

  const openTab = useCallback(
    (sql?: string, snippet?: Snippet) => {
      // A snippet already open is switched to, not duplicated.
      const open = snippet && tabs.find(t => t.snippetId === snippet.id);
      if (open) return setActiveId(open.id);
      const tab = { ...newTab(tabs.length + 1, sql), ...(snippet ? { title: snippet.name, snippetId: snippet.id } : {}) };
      setTabs(current => [...current, tab]);
      setActiveId(tab.id);
    },
    [tabs, setTabs, setActiveId]
  );

  // A query handed over in the URL opens as its own tab, once.
  const [handedOver] = useState(queryFromUrl);
  useEffect(() => {
    if (!handedOver) return;
    openTab(handedOver);
    dropQueryParam();
    // Only on mount: openTab changes with the tab count, which would re-open it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handedOver]);

  const patchActive = (patch: Partial<SqlTab>) =>
    setTabs(current => current.map(t => (t.id === active?.id ? { ...t, ...patch } : t)));

  const remember = (entry: SqlHistoryEntry) =>
    setHistory(current => [entry, ...current].slice(0, HISTORY_LIMIT));

  const run = useMutation({
    mutationFn: async (query: string) => {
      const started = performance.now();
      const data = await sqlApi.run(query);
      return { data, durationMs: Math.round(performance.now() - started) };
    },
    onSuccess: ({ data, durationMs }, query) => {
      patchActive({ result: data, error: undefined, durationMs });
      remember({
        id: uid(),
        sql: query,
        at: Date.now(),
        durationMs,
        rows: data.kind === 'read' ? data.rows?.length : data.rowsAffected,
      });
      if (data.wrote) void invalidateAfterArbitrarySql(qc);
    },
    onError: (error, query) => {
      const message = getErrorMessage(error) ?? 'Error';
      patchActive({ error: message, result: undefined });
      remember({ id: uid(), sql: query, at: Date.now() });
      toast.push({ kind: 'error', title: 'Query failed', message });
    },
  });

  return {
    tabs,
    active,
    activeId,
    setActiveId,
    openTab,
    closeTab: (id: string) => {
      const remaining = tabs.filter(t => t.id !== id);
      setTabs(remaining.length ? remaining : [{ id: uid(), title: 'Query 1', sql: DEFAULT_SQL }]);
      if (id === activeId && remaining[0]) setActiveId(remaining[0].id);
    },
    setSql: (sql: string) => patchActive({ sql }),
    appendSql: (text: string) => patchActive({ sql: (active?.sql ?? '') + text }),
    format: () => {
      if (!active) return;
      const formatted = formatSql(active.sql);
      if (formatted !== active.sql) patchActive({ sql: formatted });
    },
    run: () => active && run.mutate(active.sql),
    running: run.isPending,
    history,
    clearHistory: () => setHistory([]),
    removeHistoryEntry: (id: string) => setHistory(current => current.filter(e => e.id !== id)),
    snippets: library.items,
    operator: library.operator,
    folders,
    openSnippet: (snippet: Snippet) => openTab(snippet.content.sql, snippet),
    updateSnippet: (id: string, patch: Parameters<typeof library.update.mutate>[0]['patch']) => library.update.mutate({ id, patch }),
    removeSnippet: async (snippet: Snippet) => {
      const confirmed = await confirmDialog({ title: `Delete "${snippet.name}"?`, confirmLabel: 'Delete snippet', tone: 'danger' });
      if (confirmed) library.remove.mutate(snippet.id);
    },
    addFolder: async () => {
      const name = await promptDialog({ title: 'New folder', placeholder: 'Reports', confirmLabel: 'Create folder' });
      if (name) createFolder.mutate(name);
    },
    renameFolder: async (id: string, current: string) => {
      const name = await promptDialog({ title: 'Rename folder', placeholder: current, confirmLabel: 'Rename' });
      if (name && name !== current) renameFolder.mutate({ id, name });
    },
    removeFolder: async (id: string, name: string) => {
      const confirmed = await confirmDialog({
        title: `Delete folder "${name}"?`,
        description: 'Its snippets are kept and move back to the list.',
        confirmLabel: 'Delete folder',
        tone: 'danger',
      });
      if (confirmed) removeFolder.mutate(id);
    },
    /** Saves the active tab over its own snippet, or as a new one when it has none (or is a teammate's). */
    saveSnippet: async () => {
      if (!active) return;
      const linked = library.items.find(s => s.id === active.snippetId);
      if (linked && linked.ownerId === library.operator) {
        library.update.mutate({ id: linked.id, patch: { content: { sql: active.sql } } });
        toast.push({ kind: 'success', title: 'Snippet saved', message: linked.name });
        return;
      }
      const name = await promptDialog({ title: 'Save snippet', placeholder: active.title, confirmLabel: 'Save snippet' });
      if (!name) return;
      library.create.mutate({ name, content: { sql: active.sql } }, {
        onSuccess: item => {
          patchActive({ title: item.name, snippetId: item.id });
          toast.push({ kind: 'success', title: 'Snippet saved', message: item.name });
        },
      });
    },
  };
}
