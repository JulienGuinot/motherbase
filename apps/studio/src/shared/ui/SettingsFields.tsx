import { useId, type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { getErrorMessage } from '@/shared/lib/errors';
import Select from '@/shared/ui/Select';
import { Toggle } from '@/shared/ui/Toggle';
import type { FieldDef } from '@/shared/lib/settings';

/** Lets a caller swap in its own control for one field, keeping the label,
 *  help text and layout. Returning undefined keeps the generic control. */
export type FieldRenderer = (ctx: {
  field: FieldDef;
  values: Record<string, unknown>;
  setField: (key: string, value: unknown) => void;
  editable: boolean;
}) => ReactNode | undefined;

// Shared field renderer for a settings group. Used by SettingsForm (live project
// settings) and the new-project defaults editor so both render identically.
// One setting per row, Supabase-style: caption and help on the left, control on
// the right; a switch sits at the row's end, and JSON or long text takes the
// full width under its caption. A group with an `enabled` switch hides the rest
// of its fields until the switch is on.
export default function SettingsFields({
  fields,
  values,
  setField,
  editable = true,
  jsonErr,
  setJsonErr,
  renderField,
  storedSecrets,
}: {
  fields: FieldDef[];
  values: Record<string, unknown>;
  setField: (key: string, value: unknown) => void;
  editable?: boolean;
  jsonErr: Record<string, string>;
  setJsonErr: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  renderField?: FieldRenderer;
  /** Secret fields that already hold a value: their empty input keeps it. */
  storedSecrets?: ReadonlySet<string>;
}) {
  const idPrefix = useId();
  const gate = fields.find(f => f.key === 'enabled' && f.type === 'bool');
  const collapsed = !!gate && !values.enabled;
  const visibleFields = collapsed ? fields.filter(f => f.key === 'enabled') : fields;

  return (
    <div>
      {visibleFields.map(f => {
        const id = `${idPrefix}-${f.key}`;
        const custom = renderField?.({ field: f, values, setField, editable });
        const rowClass = 'border-t hairline py-4 first:border-t-0 first:pt-0 last:pb-0';

        if (custom === undefined && f.type === 'bool') {
          return (
            <div key={f.key} className={`flex items-start justify-between gap-6 ${rowClass}`}>
              <Caption field={f} htmlFor={id} />
              <Toggle id={id} checked={!!values[f.key]} onChange={v => setField(f.key, v)} disabled={!editable} />
            </div>
          );
        }

        const wide = custom === undefined && (f.type === 'json' || f.multiline);
        return (
          <div
            key={f.key}
            className={`grid gap-2 ${wide ? '' : 'sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-8'} ${rowClass}`}
          >
            {/* Beside a control, the caption drops to the control's text line. */}
            <Caption field={f} htmlFor={id} className={wide ? '' : 'sm:pt-2'} />
            <div className="min-w-0">
              {custom !== undefined ? custom : (
                <Control
                  id={id}
                  field={f}
                  value={values[f.key]}
                  setField={setField}
                  editable={editable}
                  stored={storedSecrets?.has(f.key) ?? false}
                  jsonErr={jsonErr[f.key]}
                  setJsonErr={setJsonErr}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Caption({ field, htmlFor, className = '' }: { field: FieldDef; htmlFor: string; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <label htmlFor={htmlFor} className="flex items-center gap-1.5 text-[13px]" style={{ color: 'var(--text)' }}>
        {field.label}
        {field.secret && <Lock size={11} aria-label="Stored encrypted" style={{ color: 'var(--text-mute)' }} />}
      </label>
      {field.help && (
        <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>{field.help}</p>
      )}
    </div>
  );
}

function Control({
  id,
  field: f,
  value,
  setField,
  editable,
  stored,
  jsonErr,
  setJsonErr,
}: {
  id: string;
  field: FieldDef;
  value: unknown;
  setField: (key: string, value: unknown) => void;
  editable: boolean;
  stored: boolean;
  jsonErr?: string;
  setJsonErr: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
}) {
  if (f.type === 'json') {
    return (
      <>
        <textarea
          id={id}
          className="input w-full font-mono text-[12px]"
          rows={10}
          disabled={!editable}
          defaultValue={
            typeof value === 'string'
              ? value
              : JSON.stringify(value ?? (f.placeholder?.trim().startsWith('[') ? [] : {}), null, 2)
          }
          onChange={e => {
            try {
              setField(f.key, JSON.parse(e.target.value));
              setJsonErr(k => ({ ...k, [f.key]: '' }));
            } catch (err) {
              setJsonErr(k => ({ ...k, [f.key]: getErrorMessage(err, 'Invalid JSON') }));
            }
          }}
        />
        {jsonErr && <span className="mt-1 block text-[11px]" style={{ color: 'var(--red)' }}>{jsonErr}</span>}
      </>
    );
  }

  if (f.type === 'select') {
    return (
      <Select
        id={id}
        value={String(value ?? f.default ?? '')}
        onChange={v => setField(f.key, v)}
        options={(f.options ?? []).map(o => ({ value: o.value, label: o.label }))}
        disabled={!editable}
      />
    );
  }

  if (f.multiline) {
    return (
      <textarea
        id={id}
        className="input w-full font-mono text-[12px]"
        rows={6}
        disabled={!editable}
        placeholder={f.placeholder}
        value={String(value ?? '')}
        onChange={e => setField(f.key, e.target.value)}
      />
    );
  }

  return (
    <input
      id={id}
      className="input w-full"
      type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
      // A stored secret comes back blank; saving it blank keeps the stored value.
      placeholder={stored ? '•••••••• saved, type to replace' : f.placeholder}
      disabled={!editable}
      value={String(value ?? '')}
      onChange={e => setField(f.key, f.type === 'number' ? Number(e.target.value) : e.target.value)}
    />
  );
}
