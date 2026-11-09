import { getErrorMessage } from '@/shared/lib/errors';
import { useState } from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { tablesApi, type AddColumnBody, type ColumnForeignKey } from '@/features/tables/api/tables.api';
import { useToast } from '@/shared/lib/toast';
import Select from '@/shared/ui/Select';
import { Checkbox } from '@/shared/ui/Field';
import { ColumnTypeSelect } from '@/features/tables/components/ColumnTypeSelect';


const ON_DELETE_ACTIONS: NonNullable<ColumnForeignKey['onDelete']>[] = ['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT'];

interface AddColumnFormProps {
  tableName: string;
  schema: string;
  onAdded: () => void;
  /** Sibling tables in the same schema, offered as foreign-key targets. */
  fkTargets?: string[];
}

export function AddColumnForm({ tableName, schema, onAdded, fkTargets = [] }: AddColumnFormProps) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [type, setType] = useState('text');
  const [nullable, setNullable] = useState(true);
  const [def, setDef] = useState('');
  const [saving, setSaving] = useState(false);

  const [advanced, setAdvanced] = useState(false);
  const [unique, setUnique] = useState(false);
  const [isPrimaryKey, setIsPrimaryKey] = useState(false);
  const [check, setCheck] = useState('');
  const [comment, setComment] = useState('');
  const [fkEnabled, setFkEnabled] = useState(false);
  const [fkTable, setFkTable] = useState(fkTargets[0] ?? '');
  const [fkColumn, setFkColumn] = useState('id');
  const [fkOnDelete, setFkOnDelete] = useState<NonNullable<ColumnForeignKey['onDelete']>>('NO ACTION');

  function reset() {
    setName(''); setDef(''); setCheck(''); setComment('');
    setUnique(false); setIsPrimaryKey(false); setFkEnabled(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !tableName) return;
    setSaving(true);
    try {
      const body: AddColumnBody = {
        name: name.trim(),
        type,
        nullable,
        default: def.trim() || null,
        unique: unique || undefined,
        isPrimaryKey: isPrimaryKey || undefined,
        check: check.trim() || undefined,
        comment: comment.trim() || undefined,
        references: fkEnabled && fkTable
          ? { table: fkTable, column: fkColumn.trim() || 'id', onDelete: fkOnDelete }
          : undefined,
      };
      await tablesApi.addColumn(tableName, schema, body);
      toast.push({ kind: 'success', title: 'Column added', message: name });
      reset();
      onAdded();
    } catch (err) {
      toast.push({ kind: 'error', title: 'Add failed', message: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 border hairline p-4" style={{ background: 'var(--ink-2)' }}>
      <div className="label">Add column</div>
      <div className="flex flex-wrap items-center gap-3">
        <input value={name} onChange={event => setName(event.target.value)} placeholder="column_name" className="input w-40" required />
        <ColumnTypeSelect
          schema={schema}
          value={type}
          onChange={setType}
          ariaLabel="Column type"
          style={{ width: '10rem', fontFamily: 'var(--font-mono)' }}
        />
        <Checkbox checked={nullable} onChange={setNullable} label="Nullable" />
        <input value={def} onChange={event => setDef(event.target.value)} placeholder="DEFAULT (optional)" className="input w-40" />
        <button type="submit" disabled={saving || !name.trim() || !tableName} className="btn btn-primary">
          <Plus size={14} /> Add column
        </button>
      </div>

      <button
        type="button"
        onClick={() => setAdvanced(a => !a)}
        className="flex items-center gap-1 text-[11px]"
        style={{ color: 'var(--text-mute)' }}
      >
        {advanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Advanced options
      </button>

      {advanced && (
        <div className="space-y-3 border-t hairline pt-3">
          <div className="flex flex-wrap items-center gap-4">
            <Checkbox checked={unique} onChange={setUnique} label="Unique" />
            <Checkbox checked={isPrimaryKey} onChange={setIsPrimaryKey} label="Primary key" />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={fkEnabled}
                onChange={e => setFkEnabled(e.target.checked)}
                disabled={fkTargets.length === 0}
              />
              Foreign key
            </label>
            {fkEnabled && (
              <>
                <Select
                  value={fkTable}
                  onChange={setFkTable}
                  ariaLabel="Referenced table"
                  style={{ width: '11rem', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                  options={fkTargets.map(t => ({ value: t, label: t }))}
                />
                <input
                  value={fkColumn}
                  onChange={e => setFkColumn(e.target.value)}
                  placeholder="ref column"
                  className="input w-32"
                />
                <Select
                  value={fkOnDelete}
                  onChange={v => setFkOnDelete(v as NonNullable<ColumnForeignKey['onDelete']>)}
                  ariaLabel="On delete action"
                  style={{ width: '9rem', fontSize: 12 }}
                  options={ON_DELETE_ACTIONS.map(a => ({ value: a, label: `on delete ${a.toLowerCase()}` }))}
                />
              </>
            )}
          </div>

          <input
            value={check}
            onChange={e => setCheck(e.target.value)}
            placeholder="CHECK expression, e.g. age >= 0"
            className="input w-full"
            style={{ fontFamily: 'var(--font-mono)' }}
          />
          <input
            value={comment}
            onChange={e => setComment(e.target.value)}
            placeholder="Comment (optional)"
            className="input w-full"
          />
        </div>
      )}
    </form>
  );
}
