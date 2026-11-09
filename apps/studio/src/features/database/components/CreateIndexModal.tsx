'use client';

import { useState } from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { Checkbox, Field } from '@/shared/ui/Field';
import Select from '@/shared/ui/Select';
import type { SchemaTable } from '@/shared/types/schema';
import { ColumnChips } from '@/features/tables/components/ColumnChips';
import { INDEX_METHODS, type IndexMethod } from '@/features/database/api/catalog.api';

export interface IndexDraft {
  table: string;
  columns: string[];
  unique: boolean;
  method: IndexMethod;
  /** Empty lets the server name it `idx_<table>_<columns>`. */
  name: string;
}

const METHOD_HINT: Record<IndexMethod, string> = {
  btree: 'Equality and range lookups, sorting. The right default.',
  hash: 'Equality only.',
  gin: 'jsonb, arrays and full-text search.',
  gist: 'Geometry, ranges, nearest-neighbour.',
  brin: 'Huge append-only tables ordered by the column, such as timestamps.',
  spgist: 'Partitioned search trees: points, IP ranges, text prefixes.',
};

export function CreateIndexModal({
  schema,
  tables,
  saving,
  onSave,
  onClose,
}: {
  schema: string;
  tables: SchemaTable[];
  saving: boolean;
  onSave: (draft: IndexDraft) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<IndexDraft>({
    table: tables[0]?.name ?? '',
    columns: [],
    unique: false,
    method: 'btree',
    name: '',
  });
  const columns = tables.find(table => table.name === draft.table)?.columns.map(column => column.name) ?? [];
  const patch = (next: Partial<IndexDraft>) => setDraft(current => ({ ...current, ...next }));

  return (
    <Modal onClose={onClose}>
      <ModalHeader eyebrow={schema} title="Create index" description="Columns are indexed in the order you pick them." />
      <ModalBody className="space-y-4">
        <Field label="Table">
          <Select
            value={draft.table}
            onChange={table => patch({ table, columns: [] })}
            ariaLabel="Table"
            options={tables.map(table => ({ value: table.name, label: table.name }))}
            className="w-full"
          />
        </Field>
        <Field label="Columns" hint={draft.columns.length ? draft.columns.join(', ') : 'Pick one or more.'}>
          <ColumnChips columns={columns} value={draft.columns} onChange={picked => patch({ columns: picked })} />
        </Field>
        <Field label="Method" hint={METHOD_HINT[draft.method]}>
          <Select
            value={draft.method}
            onChange={method => patch({ method: method as IndexMethod })}
            ariaLabel="Index method"
            options={INDEX_METHODS.map(method => ({ value: method, label: method }))}
            className="w-full"
          />
        </Field>
        <Field label="Name" hint="Optional.">
          <input className="input mono w-full" value={draft.name} placeholder={`idx_${draft.table}_${draft.columns.join('_') || '…'}`} onChange={event => patch({ name: event.target.value })} />
        </Field>
        <Checkbox checked={draft.unique} onChange={unique => patch({ unique })} label="Unique: reject rows that repeat these values" />
      </ModalBody>
      <ModalFooter>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={saving || !draft.table || !draft.columns.length} onClick={() => onSave(draft)}>
          Create index
        </button>
      </ModalFooter>
    </Modal>
  );
}
