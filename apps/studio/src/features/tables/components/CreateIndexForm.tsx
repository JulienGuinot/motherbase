import { getErrorMessage } from '@/shared/lib/errors';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { tablesApi } from '@/features/tables/api/tables.api';
import { useToast } from '@/shared/lib/toast';
import Select from '@/shared/ui/Select';
import { Checkbox } from '@/shared/ui/Field';
import { ColumnChips } from '@/features/tables/components/ColumnChips';
// The server's list: it refuses any other method.
import { INDEX_METHODS, type IndexMethod } from '@/features/database/api/catalog.api';

interface CreateIndexFormProps {
  tableName: string;
  columns: string[];
  schema: string;
  onCreated: () => void;
}

export function CreateIndexForm({ tableName, columns, schema, onCreated }: CreateIndexFormProps) {
  const toast = useToast();
  const [selectedCols, setSelectedCols] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);
  const [method, setMethod] = useState<IndexMethod>('btree');
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedCols.length || !tableName) return;
    setSaving(true);
    try {
      await tablesApi.createIndex(tableName, schema, { columns: selectedCols, unique, method });
      toast.push({ kind: 'success', title: 'Index created' });
      setSelectedCols([]);
      onCreated();
    } catch (err) {
      toast.push({ kind: 'error', title: 'Create failed', message: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 border hairline p-4" style={{ background: 'var(--ink-2)' }}>
      <div className="label">Create index</div>
      <div className="flex flex-wrap gap-3">
        <ColumnChips columns={columns} value={selectedCols} onChange={setSelectedCols} className="max-h-20 w-48 overflow-y-auto" />
        <div className="flex flex-col gap-2">
          <Select
            value={method}
            onChange={value => setMethod(value as IndexMethod)}
            ariaLabel="Index method"
            style={{ width: '8rem' }}
            options={INDEX_METHODS.map(item => ({ value: item, label: item }))}
          />
          <Checkbox checked={unique} onChange={setUnique} label="Unique" />
        </div>
        <button type="submit" disabled={saving || !selectedCols.length || !tableName} className="btn btn-primary self-start">
          <Plus size={14} /> Create index
        </button>
      </div>
    </form>
  );
}