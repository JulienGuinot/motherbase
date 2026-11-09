import { getErrorMessage } from '@/shared/lib/errors';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { GripVertical, Key, Plus, Trash2 } from 'lucide-react';
import { tablesApi } from '@/features/tables/api/tables.api';
import Select from '@/shared/ui/Select';
import { useToast } from '@/shared/lib/toast';
import { useSchema } from '@/shared/lib/schema';
import { Modal, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { CodeBlock } from '@/shared/ui/CodeBlock';
import { ColumnTypeSelect } from '@/features/tables/components/ColumnTypeSelect';

interface ColumnDef {
  name: string;
  type: string;
  nullable: boolean;
  default: string;
  isPrimaryKey: boolean;
}

interface Props {
  onClose: () => void;
  onCreated?: (name: string) => void;
}

// The first entry is preselected, so it has to be the one that exposes nothing:
// a new table often ends up holding user data before anyone revisits its
// policies. `starter` used to be the default and let every signed-in user
// rewrite every row. The labels say who can do what, not just a name.
const POLICY_PRESETS = [
  { id: 'admin_only', label: 'Closed: admins only, add policies later' },
  { id: 'starter', label: 'Starter: anyone reads, any signed-in user writes any row' },
  { id: 'authenticated_crud', label: 'Signed-in users: read and write any row' },
  { id: 'public_crud', label: 'Public: anyone reads and writes any row' },
  { id: 'blocked', label: 'Blocked: no REST access at all' },
];

/**
 * @param schema the schema on screen. The statement used to be unqualified, so
 * it always resolved against `search_path` and created the table in `public`
 * regardless of which schema the operator had selected.
 */
function buildSQL(schema: string, tableName: string, columns: ColumnDef[]): string {
  const cols = columns.map(col => {
    const notNull = col.nullable ? '' : ' NOT NULL';
    const def = col.default ? ` DEFAULT ${col.default}` : '';
    const pk = col.isPrimaryKey ? ' PRIMARY KEY' : '';
    return `  "${col.name}" ${col.type}${pk}${notNull}${def}`;
  });
  return `CREATE TABLE "${schema}"."${tableName}" (\n${cols.join(',\n')}\n);`;
}

export default function NewTableModal({ onClose, onCreated }: Props) {
  const toast = useToast();
  const qc = useQueryClient();
  const { schema } = useSchema();
  const [tableName, setTableName] = useState('');
  const [columns, setColumns] = useState<ColumnDef[]>([
    { name: 'id', type: 'uuid', nullable: false, default: 'gen_random_uuid()', isPrimaryKey: true },
    { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()', isPrimaryKey: false },
  ]);
  const [policyPreset, setPolicyPreset] = useState(POLICY_PRESETS[0].id);
  const [saving, setSaving] = useState(false);

  function addColumn() {
    setColumns(current => [...current, { name: '', type: 'text', nullable: true, default: '', isPrimaryKey: false }]);
  }

  function updateColumn(index: number, patch: Partial<ColumnDef>) {
    setColumns(current => current.map((col, i) => i === index ? { ...col, ...patch } : col));
  }

  function removeColumn(index: number) {
    setColumns(current => current.filter((_, i) => i !== index));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const name = tableName.trim();
    if (!name || columns.some(col => !col.name.trim())) return;
    setSaving(true);
    try {
      const result = await tablesApi.createTable(buildSQL(schema, name, columns), policyPreset);
      // REST and the RLS presets cover `public` only; the server says so when it
      // created the table elsewhere, and the operator hears it here rather than
      // discovering the missing endpoints later.
      const notExposed = result?.notRestExposed;
      toast.push({
        kind: 'success',
        title: 'Table created',
        message: notExposed?.length
          ? `${name} · outside public, so it gets no REST endpoints and no RLS preset`
          : name,
      });
      qc.invalidateQueries({ queryKey: ['tables'] });
      qc.invalidateQueries({ queryKey: ['api-policies'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      if (onCreated) onCreated(name);
      else onClose();
    } catch (err) {
      toast.push({ kind: 'error', title: 'Create failed', message: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  const validForPreview = tableName.trim() && columns.every(col => col.name.trim());
  const sql = validForPreview ? buildSQL(schema, tableName.trim(), columns) : '';

  return (
    <Modal onClose={onClose} width="960px">
      <form onSubmit={submit} className="flex flex-col min-h-0 flex-1">
        <ModalHeader
          title="Compose a table"
          description="Sketch the shape of a new relation. Columns are translated to standard SQL on the right."
        />

        <div className="grid md:grid-cols-[1fr_360px] flex-1 overflow-y-auto">
          {/* min-w-0: a grid item sizes to its content by default, so the
              640px-wide column editor below stretched this whole column and
              took the table-name field and the SQL preview off the right of a
              phone screen. The editor scrolls inside its own box instead. */}
          <div className="min-w-0 space-y-5 p-4 sm:p-6">
            <label className="block">
              <span className="mb-1.5 block text-[12px]" style={{ color: 'var(--text-dim)', fontWeight: 500 }}>Table name</span>
              <input
                value={tableName}
                onChange={event => setTableName(event.target.value)}
                placeholder="my_table"
                className="input mono"
                required
                autoFocus
              />
            </label>

            <div className="overflow-x-auto">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[13px]" style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Columns</span>
                <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
                  {columns.length} column{columns.length === 1 ? '' : 's'}
                </span>
              </div>

              <div className="grid min-w-[640px] grid-cols-[14px_1fr_120px_1fr_auto_auto_auto] items-center gap-x-2 gap-y-0 px-1 pb-1.5">
                <span />
                <span className="label">name</span>
                <span className="label">type</span>
                <span className="label">default</span>
                <span className="label text-center">null</span>
                <span className="label text-center">pk</span>
                <span />
              </div>

              <div className="min-w-[640px] border hairline" style={{ background: 'var(--ink-2)' }}>
                {columns.map((col, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[14px_1fr_120px_1fr_auto_auto_auto] items-center gap-x-2 px-2 py-1.5 border-b hairline last:border-b-0"
                  >
                    <GripVertical size={12} style={{ color: 'var(--paper-mute)', cursor: 'grab' }} />
                    <input
                      value={col.name}
                      onChange={event => updateColumn(i, { name: event.target.value })}
                      placeholder="column_name"
                      className="input mono"
                      style={{ padding: '0.35rem 0.55rem', fontSize: 12 }}
                    />
                    <ColumnTypeSelect
                      schema={schema}
                      value={col.type}
                      onChange={type => updateColumn(i, { type })}
                      ariaLabel="Column type"
                      style={{ padding: '0.35rem 0.55rem', fontSize: 12, fontFamily: 'var(--font-mono)' }}
                    />
                    <input
                      value={col.default}
                      onChange={event => updateColumn(i, { default: event.target.value })}
                      placeholder="—"
                      className="input mono"
                      style={{ padding: '0.35rem 0.55rem', fontSize: 12 }}
                    />
                    <Checkbox
                      checked={col.nullable}
                      onChange={value => updateColumn(i, { nullable: value })}
                    />
                    <Checkbox
                      checked={col.isPrimaryKey}
                      onChange={value => updateColumn(i, { isPrimaryKey: value })}
                      icon={<Key size={10} />}
                      activeColor="var(--accent)"
                    />
                    <button
                      type="button"
                      onClick={() => removeColumn(i)}
                      className="btn btn-ghost"
                      style={{ color: 'var(--danger)', padding: '0.3rem 0.45rem' }}
                      title="Remove column"
                      disabled={columns.length === 1}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>

              <button type="button" onClick={addColumn} className="btn mt-3">
                <Plus size={12} /> Add column
              </button>
            </div>

            <label className="block">
              <span className="mb-1.5 block text-[12px]" style={{ color: 'var(--text-dim)', fontWeight: 500 }}>REST permissions</span>
              <Select
                value={policyPreset}
                onChange={setPolicyPreset}
                ariaLabel="Policy preset"
                style={{ width: '100%' }}
                options={POLICY_PRESETS.map(preset => ({ value: preset.id, label: preset.label }))}
              />
            </label>
          </div>

          {/* min-w-0 here too: stacked under the form on a phone, this column's
              longest SQL line was setting the width of the whole grid track,
              which is what pushed the form off the screen. The code block
              scrolls inside itself instead. */}
          <aside
            className="flex min-w-0 flex-col border-t md:border-t-0 md:border-l hairline"
            style={{ background: 'var(--code-bg)' }}
          >
            <div className="border-b hairline px-4 py-2.5 flex items-center justify-between">
              <span className="text-[13px]" style={{ color: 'var(--text-dim)', fontWeight: 600 }}>SQL preview</span>
              {validForPreview && (
                <span className="label" style={{ color: 'var(--green)' }}>Ready</span>
              )}
            </div>
            <CodeBlock
              value={sql || '-- fill in a table name and column names\n-- to preview the SQL statement'}
              language="sql"
              size="sm"
              maxHeight="100%"
              copyable={false}
              bare
              className="flex-1"
              style={{ border: 0, borderRadius: 0 }}
            />
          </aside>
        </div>

        <ModalFooter>
          <button type="button" onClick={onClose} className="btn">Cancel</button>
          <button type="submit" disabled={saving || !tableName.trim()} className="btn btn-primary">
            {saving ? 'Creating…' : 'Create table'}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function Checkbox({
  checked,
  onChange,
  icon,
  activeColor = 'var(--paper)',
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  icon?: React.ReactNode;
  activeColor?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="mx-auto flex h-[18px] w-[18px] items-center justify-center"
      style={{
        background: checked ? activeColor : 'transparent',
        border: '1px solid',
        borderColor: checked ? activeColor : 'var(--hairline-strong)',
        color: checked ? 'var(--accent-fg)' : 'var(--paper-mute)',
        borderRadius: 'var(--radius-sm)',
        transition: 'all 0.15s',
      }}
    >
      {icon ?? (checked ? '✓' : '')}
    </button>
  );
}
