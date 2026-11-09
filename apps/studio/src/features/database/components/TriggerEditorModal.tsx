import { createPortal } from 'react-dom';
import CodeMirror from '@uiw/react-codemirror';
import { sql as sqlLanguage } from '@codemirror/lang-sql';
import { Code2 } from 'lucide-react';
import Select from '@/shared/ui/Select';
import { useCodeMirrorTheme, overlayTooltips } from '@/shared/lib/codemirror-theme';
import type { TriggerFnRef, TriggerTableRef } from '@/features/database/api/triggers.api';
import { Field } from '@/shared/ui/Field';
import { CodeBlock } from '@/shared/ui/CodeBlock';
import {
  canSaveTrigger,
  generateTriggerSql,
  TRIGGER_EVENTS,
  type TriggerDraft,
  type TriggerEvent,
} from '@/features/database/lib/trigger-draft';

interface TriggerEditorModalProps {
  draft: TriggerDraft;
  /** Schema the trigger is being created in; the generated SQL is qualified with it. */
  schema: string;
  tables: TriggerTableRef[];
  functions: TriggerFnRef[];
  saving: boolean;
  onChange: (draft: TriggerDraft) => void;
  onSave: (draft: TriggerDraft) => void;
  onClose: () => void;
}

export function TriggerEditorModal({
  draft,
  schema,
  tables,
  functions,
  saving,
  onChange,
  onSave,
  onClose,
}: TriggerEditorModalProps) {
  const codeMirrorTheme = useCodeMirrorTheme();

  function toggleEvent(event: TriggerEvent) {
    onChange({ ...draft, events: { ...draft.events, [event]: !draft.events[event] } });
  }

  function toggleAdvanced() {
    onChange({
      ...draft,
      advanced: !draft.advanced,
      rawSql: draft.advanced ? draft.rawSql : draft.rawEdited ? draft.rawSql : generateTriggerSql(draft, schema),
    });
  }

  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto" onClick={onClose}>
      <div className="modal-scrim fixed inset-0" />
      <div className="relative flex min-h-full items-center justify-center p-4">
        <div onClick={event => event.stopPropagation()} className="card relative w-[min(680px,92vw)] p-6">
          <div className="flex items-center justify-between">
            <h3 className="mt-3 text-[17px]" style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>
              {draft.editing ? 'Edit trigger' : 'Create trigger'}
            </h3>
            <button type="button" onClick={toggleAdvanced} className="btn btn-ghost" title="Toggle raw SQL">
              <Code2 size={13} /> {draft.advanced ? 'Form' : 'Advanced SQL'}
            </button>
          </div>

          {draft.advanced ? (
            <div className="mt-5">
              <div className="label mb-1">Create trigger SQL</div>
              <div className="overflow-hidden border hairline" style={{ height: 280 }}>
                <CodeMirror
                  value={draft.rawSql}
                  height="280px"
                  extensions={[sqlLanguage(), overlayTooltips]}
                  theme={codeMirrorTheme}
                  onChange={value => onChange({ ...draft, rawSql: value, rawEdited: true })}
                  style={{ fontSize: 13 }}
                />
              </div>
            </div>
          ) : (
            <div className="mt-5 space-y-4">
              <Field label="Name">
                <input
                  value={draft.name}
                  onChange={event => onChange({ ...draft, name: event.target.value })}
                  placeholder="e.g. set_updated_at"
                  className="input mono"
                />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Table">
                  <Select
                    value={draft.table}
                    onChange={value => onChange({ ...draft, table: value })}
                    placeholder="Select a table"
                    ariaLabel="Table"
                    style={{ width: '100%' }}
                    options={tables.map(table => ({ value: table.name, label: table.name }))}
                  />
                </Field>
                <Field label="Function">
                  <Select
                    value={draft.fn}
                    onChange={value => onChange({ ...draft, fn: value })}
                    placeholder="Select a function"
                    ariaLabel="Function"
                    style={{ width: '100%' }}
                    options={functions.map(fn => ({ value: fn.name, label: `${fn.name}()` }))}
                  />
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <TriggerChoice
                  label="Timing"
                  options={['BEFORE', 'AFTER']}
                  value={draft.timing}
                  onChange={timing => onChange({ ...draft, timing })}
                />
                <TriggerChoice
                  label="For each"
                  options={['ROW', 'STATEMENT']}
                  value={draft.orientation}
                  onChange={orientation => onChange({ ...draft, orientation })}
                />
              </div>

              <Field label="Events">
                <div className="flex flex-wrap gap-2">
                  {TRIGGER_EVENTS.map(event => (
                    <ChoiceButton key={event} active={draft.events[event]} onClick={() => toggleEvent(event)}>{event}</ChoiceButton>
                  ))}
                </div>
              </Field>

              <Field label="Generated SQL">
                <CodeBlock
                  value={canSaveTrigger(draft) ? generateTriggerSql(draft, schema) : '-- complete the form to preview'}
                  language="sql"
                  size="sm"
                  maxHeight={240}
                />
              </Field>
            </div>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <button onClick={onClose} className="btn">Cancel</button>
            <button onClick={() => onSave(draft)} className="btn btn-primary" disabled={!canSaveTrigger(draft) || saving}>
              {saving ? 'Saving...' : draft.editing ? 'Save' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface TriggerChoiceProps<T extends string> {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}

function TriggerChoice<T extends string>({ label, options, value, onChange }: TriggerChoiceProps<T>) {
  return (
    <div>
      <div className="label mb-1">{label}</div>
      <div className="flex gap-2">
        {options.map(option => <ChoiceButton key={option} active={value === option} onClick={() => onChange(option)}>{option}</ChoiceButton>)}
      </div>
    </div>
  );
}

interface ChoiceButtonProps {
  active: boolean;
  onClick: () => void;
  children: string;
}

function ChoiceButton({ active, onClick, children }: ChoiceButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="chip"
      style={{
        background: active ? 'var(--accent)' : 'transparent',
        color: active ? 'var(--accent-fg)' : 'var(--paper-dim)',
        borderColor: active ? 'var(--accent)' : undefined,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
