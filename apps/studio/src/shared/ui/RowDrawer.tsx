import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Trash2, Save, AlertTriangle } from 'lucide-react';
import CopyButton from '@/shared/ui/CopyButton';
import { useDialogBehavior } from '@/shared/hooks/useDialogBehavior';

export interface FieldMeta {
  name: string;
  type: string;
  kind: 'scalar' | 'object' | 'enum';
  isId: boolean;
  isReadOnly: boolean;
  isRequired: boolean;
  sensitive: boolean;
}

export interface RowDrawerProps {
  fields: FieldMeta[];
  primaryKey: string;
  row: Record<string, unknown> | null;
  saving: boolean;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => void;
  onDelete?: () => void;
  /** Column name to the table its foreign key points at. */
  references?: Record<string, string>;
}

/** Shared with the grid's in-place cell editor, so both agree on what is writable. */
export const isEditable = (f: FieldMeta) => f.kind === 'scalar' && !f.isId && !f.isReadOnly && !f.sensitive;
export const isNumeric = (t: string) => t === 'Int' || t === 'Float' || t === 'BigInt' || t === 'Decimal';

/**
 * Required foreign keys the draft leaves blank. An empty string never matches a
 * row, so sending one only comes back as a constraint error that does not say
 * which column or which table: a new row on a table with a `userId` failed
 * that way, with nothing in the form even naming the column.
 */
export function blankRequiredReferences(
  fields: FieldMeta[],
  draft: Record<string, unknown>,
  references: Record<string, string>,
): string[] {
  return fields
    .filter(f => f.isRequired && references[f.name] && (draft[f.name] ?? '') === '')
    .map(f => f.name);
}

/** Human-readable display of unknown stored value for the read-only section. */
function displayValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export default function RowDrawer({ fields, primaryKey, row, saving, onClose, onSave, onDelete, references = {} }: RowDrawerProps) {
  const editable = fields.filter(isEditable);
  // Non-editable, non-sensitive columns (id, timestamps, relations) shown
  // read-only so the operator can still see and copy their values while editing.
  const readonly = fields.filter(f => !isEditable(f) && !f.sensitive && f.name !== primaryKey);
  const [draft, setDraft] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const field of editable) initial[field.name] = row?.[field.name] ?? (field.type === 'Boolean' ? false : '');
    return initial;
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [blank, setBlank] = useState<string[]>([]);

  function set(name: string, value: unknown) {
    setDraft(d => ({ ...d, [name]: value }));
    setBlank(b => b.filter(n => n !== name));
  }

  function submit() {
    const unset = blankRequiredReferences(editable, draft, references);
    setBlank(unset);
    if (unset.length) return;
    const payload: Record<string, unknown> = {};
    for (const f of editable) {
      const v = draft[f.name];
      if (v === '' && !f.isRequired) continue;
      payload[f.name] = isNumeric(f.type) ? Number(v) : v;
    }
    onSave(payload);
  }

  const panelRef = useDialogBehavior(onClose);

  return createPortal(
    <div className="fixed inset-0 z-50 flex">
      <div className="modal-scrim flex-1" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={row ? 'Edit row' : 'New row'}
        tabIndex={-1}
        className="card flex w-full flex-col overflow-hidden border-l hairline-strong rise sm:w-[30rem]"
        style={{ background: 'var(--surface)', animationDuration: '0.3s' }}
      >
        <div className="flex items-center justify-between border-b hairline px-4 py-4 pt-7 sm:px-5">
          <div>
            <h2 className="text-[17px] leading-none" style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>{row ? 'Edit row' : 'New row'}</h2>
            {row && (
              <p className="mt-1 flex items-center gap-1 mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
                {primaryKey}: <span style={{ color: 'var(--text)' }}>{String(row[primaryKey])}</span>
                <CopyButton value={String(row[primaryKey])} title={`Copy ${primaryKey}`} />
              </p>
            )}
          </div>
          <button onClick={onClose} className="btn btn-ghost"><X size={14} /></button>
        </div>

        <div className="flex-1 space-y-4 overflow-auto px-4 py-4 sm:px-5">
          {editable.map(f => (
            <label key={f.name} className="block">
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="label">{f.name}</span>
                <span className="mono text-[9px]" style={{ color: 'var(--text-mute)' }}>
                  {f.type}{references[f.name] ? ` → ${references[f.name]}` : ''}{f.isRequired ? ' · required' : ''}
                </span>
              </div>
              {f.type === 'Boolean' ? (
                <button
                  type="button"
                  onClick={() => set(f.name, !draft[f.name])}
                  className="flex items-center gap-2 rounded-[var(--radius-sm)] border hairline-strong px-3 py-2 text-[12px]"
                  style={{
                    background: draft[f.name] ? 'var(--accent)' : 'var(--surface-2)',
                    color: draft[f.name] ? 'var(--accent-fg)' : 'var(--text-dim)',
                    borderColor: draft[f.name] ? 'var(--accent)' : undefined,
                  }}
                >
                  {draft[f.name] ? 'true' : 'false'}
                </button>
              ) : (
                <input
                  type={isNumeric(f.type) ? 'number' : 'text'}
                  value={draft[f.name] == null ? '' : String(draft[f.name])}
                  onChange={e => set(f.name, e.target.value)}
                  placeholder={references[f.name] ? `id of a ${references[f.name]} row` : undefined}
                  aria-invalid={blank.includes(f.name) || undefined}
                  className="input mono text-[12px]"
                />
              )}
              {blank.includes(f.name) && (
                <p className="mt-1 text-[11px]" style={{ color: 'var(--red)' }}>
                  Every row here belongs to a {references[f.name]} row. Paste the id of the one it belongs to.
                </p>
              )}
            </label>
          ))}
          {editable.length === 0 && (
            <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
              No editable columns on this model.
            </p>
          )}

          {row && readonly.length > 0 && (
            <div className="border-t hairline pt-4 space-y-3">
              <span className="label">Read-only</span>
              {readonly.map(f => {
                const text = displayValue(row[f.name]);
                return (
                  <div key={f.name}>
                    <div className="mb-1 flex items-baseline justify-between">
                      <span className="label">{f.name}</span>
                      <span className="mono text-[9px]" style={{ color: 'var(--text-mute)' }}>{f.type}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <code
                        className="input mono flex-1 truncate text-[12px]"
                        style={{ color: 'var(--text-dim)' }}
                        title={text}
                      >
                        {text}
                      </code>
                      <CopyButton value={text} title={`Copy ${f.name}`} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t hairline p-3">
          {confirmDelete ? (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--red)' }}>
                <AlertTriangle size={13} /> Delete permanently?
              </div>
              <div className="flex gap-2">
                <button onClick={() => setConfirmDelete(false)} className="btn">Cancel</button>
                <button
                  onClick={onDelete}
                  disabled={saving}
                  className="btn"
                  style={{ background: 'var(--red)', color: '#fff', borderColor: 'var(--red)' }}
                >
                  <Trash2 size={12} /> Confirm
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              {row && onDelete ? (
                <button
                  onClick={() => setConfirmDelete(true)}
                  disabled={saving}
                  className="btn"
                  style={{ color: 'var(--red)', borderColor: 'color-mix(in srgb, var(--red) 30%, transparent)' }}
                >
                  <Trash2 size={12} /> Delete
                </button>
              ) : (
                <span />
              )}
              <button onClick={submit} disabled={saving} className="btn btn-primary">
                <Save size={12} /> {saving ? 'Saving…' : row ? 'Save changes' : 'Create row'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
