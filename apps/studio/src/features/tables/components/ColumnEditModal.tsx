import { getErrorMessage } from '@/shared/lib/errors';
import { useState } from 'react';
import { tablesApi } from '@/features/tables/api/tables.api';
import { useToast } from '@/shared/lib/toast';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import type { SchemaTable } from '@/shared/types/schema';
import { Field, Checkbox } from '@/shared/ui/Field';

interface ColumnEditModalProps {
  tableName: string;
  column: SchemaTable['columns'][number];
  schema: string;
  onClose: () => void;
  onSaved: () => void;
}

export function ColumnEditModal({ tableName, column, schema, onClose, onSaved }: ColumnEditModalProps) {
  const toast = useToast();
  const [name, setName] = useState(column.name);
  const [nullable, setNullable] = useState(column.nullable);
  const [def, setDef] = useState(column.default ?? '');
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName || !tableName) return;
    setSaving(true);
    try {
      let currentName = column.name;
      if (nextName !== column.name) {
        await tablesApi.renameColumn(tableName, column.name, schema, nextName);
        currentName = nextName;
      }
      if (nullable !== column.nullable) {
        await tablesApi.setColumnNullable(tableName, currentName, schema, nullable);
      }
      const nextDefault = def.trim() || null;
      if (nextDefault !== (column.default ?? null)) {
        await tablesApi.setColumnDefault(tableName, currentName, schema, nextDefault);
      }
      toast.push({ kind: 'success', title: 'Column updated', message: nextName });
      onSaved();
    } catch (err) {
      toast.push({ kind: 'error', title: 'Update failed', message: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} width="520px">
      <form onSubmit={submit} className="flex flex-col min-h-0 flex-1">
        <ModalHeader title="Edit column" />
        <ModalBody className="space-y-4">
          <Field label="Name">
            <input value={name} onChange={event => setName(event.target.value)} className="input mono" required />
          </Field>
          <Checkbox checked={nullable} onChange={setNullable} label="Nullable" />
          <Field label="Default">
            <input value={def} onChange={event => setDef(event.target.value)} className="input mono" placeholder="empty drops default" />
          </Field>
        </ModalBody>
        <ModalFooter>
          <button type="button" onClick={onClose} className="btn">Cancel</button>
          <button type="submit" disabled={saving || !name.trim()} className="btn btn-primary">
            {saving ? 'Saving...' : 'Save column'}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}