'use client';

import RowDrawer from '@/shared/ui/RowDrawer';
import { WorkbenchShell } from '@/shared/ui/PageHeader';
import { Tabs } from '@/shared/ui/Tabs';
import { useContextMenu } from '@/shared/hooks/useContextMenu';
import { useTableEditor } from '@/features/tables/hooks/useTableEditor';
import { ColumnEditModal } from '@/features/tables/components/ColumnEditModal';
import NewTableModal from '@/features/tables/components/NewTableModal';
import { TableContextMenus } from '@/features/tables/components/TableContextMenus';
import { TableDataPanel } from '@/features/tables/components/TableDataPanel';
import { TableSidebar } from '@/features/tables/components/TableSidebar';
import { TableStructurePanel } from '@/features/tables/components/TableStructurePanel';
import type { TableMeta } from '@/features/tables/components/table.types';

export default function Tables() {
  const editor = useTableEditor();
  const rowMenu = useContextMenu<Record<string, unknown>>();
  const tableMenu = useContextMenu<TableMeta>();

  return (
    <WorkbenchShell>
      <TableSidebar
        tables={editor.tables}
        activeModel={editor.active}
        search={editor.tableSearch}
        loading={editor.tablesLoading}
        readOnly={editor.readOnly}
        onSearchChange={editor.setTableSearch}
        onCreateTable={() => editor.setNewTableOpen(true)}
        onSelectTable={table => editor.openTable(table.model, true)}
        onTableContextMenu={tableMenu.onContextMenu}
      />

      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Tabs
          className="px-1 pt-2 sm:px-4 sm:pt-4"
          items={editor.tabs.map(id => ({ id, label: <span className="capitalize">{id}</span> }))}
          value={editor.tab}
          onChange={editor.selectTab}
        />

        {editor.tab === 'data' && (
          <TableDataPanel
            activeModel={editor.active}
            meta={editor.meta}
            columns={editor.columns}
            rows={editor.rows}
            total={editor.total}
            totalEstimated={editor.totalEstimated}
            loading={editor.rowsLoading}
            loaded={editor.rowsLoaded}
            readOnly={editor.readOnly}
            search={editor.search}
            filters={editor.filters}
            sort={editor.sort}
            order={editor.order}
            page={editor.page}
            pageSize={editor.pageSize}
            totalPages={editor.totalPages}
            foreignTableByColumn={editor.foreignTableByColumn}
            modelByTable={editor.modelByTable}
            onSearchChange={editor.setSearch}
            onFiltersChange={editor.setFilters}
            onSort={editor.toggleSort}
            onClearSort={editor.clearSort}
            onRefresh={editor.refreshRows}
            onOpenSql={editor.openSqlForActive}
            onNewRow={() => editor.setEditing({ row: null })}
            onOpenPermissions={() => editor.selectTab('policies')}
            onOpenForeignTable={editor.openTable}
            onRowClick={row => editor.setEditing({ row })}
            onRowContextMenu={rowMenu.onContextMenu}
            onPageChange={editor.setPage}
            onPageSizeChange={editor.setPageSize}
            selected={editor.selected}
            bulkDeleting={editor.bulkDeleting}
            onToggleSelected={editor.toggleSelected}
            onToggleSelectAll={editor.toggleSelectAll}
            onClearSelection={editor.clearSelection}
            onDeleteSelected={editor.deleteSelected}
            onUpdateCell={editor.updateCell}
          />
        )}

        <TableStructurePanel
          tab={editor.tab}
          schema={editor.schema}
          meta={editor.meta}
          schemaTable={editor.schemaQuery.data}
          indexes={editor.indexesQuery.data}
          graph={editor.graphQuery.data}
          tables={editor.tables}
          schemaLoading={editor.schemaQuery.isLoading}
          indexesLoading={editor.indexesQuery.isLoading}
          graphLoading={editor.graphQuery.isLoading}
          readOnly={editor.readOnly}
          onEditColumn={editor.setEditingColumn}
          onDropColumn={editor.dropColumn}
          onColumnAdded={editor.refreshSchema}
          onDropIndex={editor.dropIndex}
          onIndexCreated={() => editor.indexesQuery.refetch()}
        />
      </section>

      {editor.newTableOpen && (
        <NewTableModal
          onClose={() => editor.setNewTableOpen(false)}
          onCreated={name => {
            editor.setNewTableOpen(false);
            editor.openTable(name);
          }}
        />
      )}

      {editor.editingColumn && editor.meta && (
        <ColumnEditModal
          tableName={editor.meta.dbName}
          column={editor.editingColumn}
          schema={editor.schema}
          onClose={() => editor.setEditingColumn(null)}
          onSaved={() => {
            editor.setEditingColumn(null);
            editor.refreshSchema();
          }}
        />
      )}

      {editor.editing && editor.meta && (
        <RowDrawer
          key={`${editor.meta.model}:${String(editor.editing.row?.[editor.meta.primaryKey] ?? 'new')}`}
          fields={editor.meta.fields}
          primaryKey={editor.meta.primaryKey}
          row={editor.editing.row}
          saving={editor.saving}
          onClose={() => editor.setEditing(null)}
          onSave={editor.saveRow}
          onDelete={editor.editing.row ? editor.deleteEditingRow : undefined}
          references={editor.foreignTableByColumn}
        />
      )}

      <TableContextMenus
        rowMenu={rowMenu.menu}
        tableMenu={tableMenu.menu}
        meta={editor.meta}
        readOnly={editor.readOnly}
        onCloseRowMenu={rowMenu.close}
        onCloseTableMenu={tableMenu.close}
        onEditRow={row => editor.setEditing({ row })}
        onDeleteRow={editor.deleteRow}
        onOpenTable={table => editor.openTable(table.model)}
        onOpenTableSql={editor.openSqlForTable}
        onOpenPermissions={editor.openPermissions}
        onDeleteTable={editor.dropTable}
        onCopied={editor.notify}
      />
    </WorkbenchShell>
  );
}
