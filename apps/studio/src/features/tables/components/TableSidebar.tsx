import type { MouseEvent } from 'react';
import { Plus, Search } from 'lucide-react';
import SchemaSelect from '@/shared/ui/SchemaSelect';
import type { TableMeta } from '@/features/tables/components/table.types';
import { SidebarHeader } from '@/shared/ui/SidebarHeader';

interface TableSidebarProps {
  tables: TableMeta[];
  activeModel: string | undefined;
  search: string;
  loading: boolean;
  readOnly: boolean;
  onSearchChange: (value: string) => void;
  onCreateTable: () => void;
  onSelectTable: (table: TableMeta) => void;
  onTableContextMenu: (event: MouseEvent, table: TableMeta) => void;
}

export function TableSidebar({
  tables,
  activeModel,
  search,
  loading,
  readOnly,
  onSearchChange,
  onCreateTable,
  onSelectTable,
  onTableContextMenu,
}: TableSidebarProps) {
  return (
    <aside className="flex h-[220px] w-full shrink-0 flex-col overflow-hidden border-b hairline md:h-auto md:w-[260px] md:border-b-0 md:border-r">
      <SidebarHeader title="Tables" actions={<span className="chip">{tables.length}</span>}>
        <SchemaSelect className="w-full justify-start" />
      </SidebarHeader>
      {!readOnly && (
        <div className="border-b hairline p-2">
          <button onClick={onCreateTable} className="btn btn-primary w-full justify-center"><Plus size={12} /> New table</button>
        </div>
      )}
      <div className="border-b hairline p-2">
        <div className="flex items-center gap-2 px-2">
          <Search size={12} style={{ color: 'var(--paper-mute)' }} />
          <input value={search} onChange={event => onSearchChange(event.target.value)} placeholder="Filter..." className="w-full bg-transparent py-1.5 text-[12px] outline-none placeholder:opacity-50" />
        </div>
      </div>
      <ul className="flex-1 overflow-auto">
        {tables.map(table => (
          <li key={table.model}>
            <button
              onClick={() => onSelectTable(table)}
              onContextMenu={event => onTableContextMenu(event, table)}
              className="group flex w-full items-center justify-between px-3 py-2 text-left text-[13px]"
              style={{
                background: table.model === activeModel ? 'var(--ink-3)' : 'transparent',
                borderLeft: `2px solid ${table.model === activeModel ? 'var(--accent)' : 'transparent'}`,
              }}
            >
              <span className="truncate" title={`model: ${table.model}`}>{table.dbName}</span>
            </button>
          </li>
        ))}
        {loading && <li className="shimmer mx-3 my-1 h-6" />}
      </ul>
    </aside>
  );
}
