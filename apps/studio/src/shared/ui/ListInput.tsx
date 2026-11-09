import { useRef, useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { addToList, splitList } from '@/shared/lib/list-values';

/**
 * A list of short values (origins, domains, scopes…) as one chip per entry.
 * Comma, space, Enter or a paste adds; clicking a chip edits it in place;
 * Backspace in the empty field reopens the last one.
 *
 * `removable={false}` is for lists whose entries can be renamed and added to
 * but never dropped, such as an enum's values: no remove button, Backspace
 * edits the last entry in place, and an edit cleared to nothing is discarded.
 *
 * `id` lands on the text field: point the caption's `htmlFor` at it. A wrapping
 * <label> without it would activate the first chip instead.
 */
export function ListInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  mono,
  validate,
  removable = true,
}: {
  id: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
  /** Error message for an entry, or null. Invalid entries are kept, and flagged. */
  validate?: (item: string) => string | null;
  removable?: boolean;
}) {
  const fieldRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
  const discardEdit = useRef(false);
  const errors = value.map(item => validate?.(item) ?? null);
  const firstInvalid = errors.findIndex(Boolean);
  const errorId = `${id}-error`;

  // Every separator the user types or pastes turns what precedes it into an
  // entry; only the unfinished tail stays in the field.
  function onType(raw: string) {
    const parts = raw.split(/[\s,]+/);
    const tail = parts.pop() ?? '';
    if (parts.length) onChange(addToList(value, parts.filter(Boolean)));
    setDraft(tail);
  }

  function commitDraft() {
    if (draft.trim()) onChange(addToList(value, splitList(draft)));
    setDraft('');
  }

  function onFieldKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && draft.trim()) {
      // Only swallow Enter when it adds something, so an empty field still submits the form.
      event.preventDefault();
      commitDraft();
    } else if (event.key === 'Backspace' && !draft && value.length) {
      event.preventDefault();
      if (!removable) {
        setEditing({ index: value.length - 1, text: value[value.length - 1] });
        return;
      }
      setDraft(value[value.length - 1]);
      onChange(value.slice(0, -1));
    }
  }

  // An edit can become several entries (a comma typed mid-edit) or none (cleared).
  // Enter and Escape both hand focus back to the field, so the blur lands here.
  function commitEdit() {
    if (!editing) return;
    if (!discardEdit.current && (removable || splitList(editing.text).length)) {
      const before = value.slice(0, editing.index);
      const after = value.slice(editing.index + 1);
      onChange(addToList(addToList(before, splitList(editing.text)), after));
    }
    discardEdit.current = false;
    setEditing(null);
  }

  function onEditKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      fieldRef.current?.focus();
    } else if (event.key === 'Escape') {
      // Cancel the edit, not the dialog around it.
      event.preventDefault();
      event.stopPropagation();
      discardEdit.current = true;
      fieldRef.current?.focus();
    }
  }

  return (
    <div>
      <div
        className={`input list-input ${mono ? 'mono' : ''}`}
        aria-disabled={disabled || undefined}
        onClick={event => {
          if (event.target === event.currentTarget) fieldRef.current?.focus();
        }}
      >
        {value.map((item, index) =>
          editing?.index === index ? (
            <input
              key={item}
              autoFocus
              aria-label={`Edit ${item}`}
              className="list-input-field"
              style={{ flex: '0 1 auto', width: `${Math.max(editing.text.length, 4) + 2}ch` }}
              value={editing.text}
              onChange={event => setEditing({ index, text: event.target.value })}
              onKeyDown={onEditKey}
              onBlur={commitEdit}
            />
          ) : (
            <span key={item} className="list-input-item" data-invalid={errors[index] ? '' : undefined} title={errors[index] ?? undefined}>
              <button
                type="button"
                disabled={disabled}
                aria-label={`Edit ${item}`}
                onClick={() => setEditing({ index, text: item })}
              >
                {item}
              </button>
              {removable && (
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${item}`}
                  onClick={() => onChange(value.filter((_, i) => i !== index))}
                >
                  <X size={11} />
                </button>
              )}
            </span>
          ),
        )}
        <input
          ref={fieldRef}
          id={id}
          className="list-input-field"
          value={draft}
          placeholder={value.length ? undefined : placeholder}
          disabled={disabled}
          aria-invalid={firstInvalid >= 0 || undefined}
          aria-describedby={firstInvalid >= 0 ? errorId : undefined}
          onChange={event => onType(event.target.value)}
          onKeyDown={onFieldKey}
          onBlur={commitDraft}
        />
      </div>
      {firstInvalid >= 0 && (
        <span id={errorId} className="mt-1 block text-[11px]" style={{ color: 'var(--red)' }}>
          <span className="mono">{value[firstInvalid]}</span>: {errors[firstInvalid]}
        </span>
      )}
    </div>
  );
}
