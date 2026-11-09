'use client';

import { useMemo, useState } from 'react';
import { sql as sqlLang } from '@codemirror/lang-sql';
import { EditorView, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { WorkbenchShell } from '@/shared/ui/PageHeader';
import { useContextMenu } from '@/shared/hooks/useContextMenu';
import { useCodeMirrorTheme, overlayTooltips } from '@/shared/lib/codemirror-theme';
import { useSchema } from '@/shared/lib/schema';
import { useSchemaTables } from '@/features/sql/hooks/useSchemaTables';
import { useSqlWorkspace } from '@/features/sql/hooks/useSqlWorkspace';
import { buildSqlConfig } from '@/features/sql/lib/sql-schema';
import { SchemaExplorer } from '@/features/sql/components/SchemaExplorer';
import { SqlItemContextMenu } from '@/features/sql/components/SqlItemContextMenu';
import { SqlLibraryPanel } from '@/features/sql/components/SqlLibraryPanel';
import { SqlWorkspace } from '@/features/sql/components/SqlWorkspace';
import { SnippetContextMenu, FolderContextMenu } from '@/features/sql/components/SnippetContextMenu';
import { groupSnippets, type Snippet } from '@/features/sql/lib/snippets';
import { SQL_TEMPLATES } from '@/features/sql/lib/workspace';
import type { ContentFolder } from '@/shared/lib/content';
import type { SqlHistoryEntry } from '@/features/sql/types';

export default function Sql() {
  const editorTheme = useCodeMirrorTheme();
  const workspace = useSqlWorkspace();

  const [sidePane, setSidePane] = useState<'snippets' | 'history'>('snippets');
  const [schemaOpen, setSchemaOpen] = useState(true);
  const [mobilePane, setMobilePane] = useState<'schema' | 'side' | null>(null);

  const snippetMenu = useContextMenu<Snippet>();
  const folderMenu = useContextMenu<ContentFolder>();
  const historyMenu = useContextMenu<SqlHistoryEntry>();

  const sections = useMemo(
    () => groupSnippets(workspace.snippets, workspace.folders, workspace.operator),
    [workspace.snippets, workspace.folders, workspace.operator],
  );

  const { schema } = useSchema();
  const schemaQuery = useSchemaTables(schema);

  // Schema-aware completion (tables, columns, helper functions), rebuilt
  // whenever the live schema changes.
  const sqlExtension = useMemo(() => sqlLang(buildSqlConfig(schemaQuery.data)), [schemaQuery.data]);

  const shortcuts = Prec.highest(
    keymap.of([
      { key: 'Mod-Enter', run: () => (workspace.run(), true) },
      { key: 'Shift-Mod-f', run: () => (workspace.format(), true) },
    ])
  );

  return (
    <WorkbenchShell layout="row">
      <SchemaExplorer
        tables={schemaQuery.data}
        isLoading={schemaQuery.isLoading}
        isError={schemaQuery.isError}
        open={schemaOpen}
        mobileOpen={mobilePane === 'schema'}
        onOpen={() => setSchemaOpen(true)}
        onClose={() => {
          setSchemaOpen(false);
          setMobilePane(null);
        }}
        onInsert={workspace.appendSql}
      />

      <SqlLibraryPanel
        mobileOpen={mobilePane === 'side'}
        pane={sidePane}
        sections={sections}
        snippetCount={workspace.snippets.length}
        templates={SQL_TEMPLATES}
        operator={workspace.operator}
        history={workspace.history}
        onPaneChange={setSidePane}
        onCloseMobile={() => setMobilePane(null)}
        onOpenQuery={workspace.openTab}
        onOpenSnippet={workspace.openSnippet}
        onToggleFavorite={snippet => workspace.updateSnippet(snippet.id, { favorite: !snippet.favorite })}
        onNewFolder={workspace.addFolder}
        onSnippetContextMenu={snippetMenu.onContextMenu}
        onFolderContextMenu={folderMenu.onContextMenu}
        onHistoryContextMenu={historyMenu.onContextMenu}
        onClearHistory={workspace.clearHistory}
      />

      <SqlWorkspace
        tabs={workspace.tabs}
        active={workspace.active}
        activeId={workspace.activeId}
        running={workspace.running}
        // lineWrapping: most pasted SQL arrives as one long line.
        editorExtensions={[sqlExtension, shortcuts, overlayTooltips, EditorView.lineWrapping]}
        editorTheme={editorTheme}
        onActiveChange={workspace.setActiveId}
        onCloseTab={workspace.closeTab}
        onNewTab={() => workspace.openTab()}
        onFormat={workspace.format}
        onSaveSnippet={workspace.saveSnippet}
        onRun={workspace.run}
        onSqlChange={workspace.setSql}
      />

      {snippetMenu.menu && (
        <SnippetContextMenu
          x={snippetMenu.menu.x}
          y={snippetMenu.menu.y}
          snippet={snippetMenu.menu.data}
          mine={snippetMenu.menu.data.ownerId === workspace.operator}
          folders={workspace.folders}
          onClose={snippetMenu.close}
          onOpen={workspace.openSnippet}
          onUpdate={workspace.updateSnippet}
          onDelete={workspace.removeSnippet}
        />
      )}

      {folderMenu.menu && (
        <FolderContextMenu
          x={folderMenu.menu.x}
          y={folderMenu.menu.y}
          folder={folderMenu.menu.data}
          onClose={folderMenu.close}
          onRename={workspace.renameFolder}
          onDelete={workspace.removeFolder}
        />
      )}

      {historyMenu.menu && (
        <SqlItemContextMenu
          x={historyMenu.menu.x}
          y={historyMenu.menu.y}
          sql={historyMenu.menu.data.sql}
          deleteLabel="Delete entry"
          onClose={historyMenu.close}
          onOpen={workspace.openTab}
          onDelete={() => workspace.removeHistoryEntry(historyMenu.menu!.data.id)}
        />
      )}
    </WorkbenchShell>
  );
}
