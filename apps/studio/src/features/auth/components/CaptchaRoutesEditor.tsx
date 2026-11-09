'use client';

import { Plus, Trash2 } from 'lucide-react';
import { Checkbox } from '@/shared/ui/Field';
import Select from '@/shared/ui/Select';
import { useSchemaTables } from '@/features/sql/hooks/useSchemaTables';

/** What each guarded auth endpoint is, in the words of the client call. */
const ENDPOINT_LABELS: Record<string, string> = {
  '/sign-up/email': 'Sign-up with a password',
  '/sign-in/email': 'Sign-in with a password',
  '/sign-in/anonymous': 'Anonymous sign-in',
  '/sign-in/magic-link': 'Magic-link request',
  '/email-otp/send-verification-otp': 'Email code request',
  '/email-otp/request-password-reset': 'Password recovery by email code',
  '/phone-number/send-otp': 'SMS code request',
  '/request-password-reset': 'Password recovery by link',
};

/**
 * The auth endpoints CAPTCHA guards. The choices are the field's own default,
 * which the server fills with every endpoint it can guard, so this list cannot
 * drift from the one the plugin enforces.
 */
export function CaptchaEndpointsPicker({ all, value, onChange, disabled }: {
  all: string[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {all.map(endpoint => (
        <Checkbox
          key={endpoint}
          checked={value.includes(endpoint)}
          disabled={disabled}
          onChange={on => onChange(on ? [...value, endpoint] : value.filter(e => e !== endpoint))}
          label={
            <span>
              {ENDPOINT_LABELS[endpoint] ?? endpoint} <span className="mono text-[11px]" style={{ color: 'var(--text-mute)' }}>{endpoint}</span>
            </span>
          }
        />
      ))}
    </div>
  );
}

export interface CaptchaRoute {
  methods?: string[];
  pathGlob: string;
}

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

/**
 * Any other route CAPTCHA guards: one row per method set + path glob. The
 * tables of `public` are offered ready-made, since their REST API is what a
 * project most often wants to protect (a contact form's insert, a vote).
 */
export function CaptchaRoutesEditor({ value, onChange, disabled }: {
  value: CaptchaRoute[];
  onChange: (next: CaptchaRoute[]) => void;
  disabled: boolean;
}) {
  const tablesQuery = useSchemaTables('public');
  const tables = tablesQuery.data ?? [];

  const patch = (index: number, next: Partial<CaptchaRoute>) =>
    onChange(value.map((route, i) => (i === index ? { ...route, ...next } : route)));
  const toggleMethod = (index: number, method: string) => {
    const methods = value[index].methods ?? [];
    patch(index, { methods: methods.includes(method) ? methods.filter(m => m !== method) : [...methods, method] });
  };

  return (
    <div className="space-y-2">
      {value.map((route, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2 rounded-md border hairline px-3 py-2">
          <input
            className="input mono min-w-0 flex-1"
            value={route.pathGlob}
            disabled={disabled}
            placeholder="/rest/v1/orders"
            aria-label="Path"
            onChange={event => patch(index, { pathGlob: event.target.value })}
          />
          <div className="flex flex-wrap gap-3">
            {METHODS.map(method => (
              <Checkbox
                key={method}
                checked={route.methods?.includes(method) ?? false}
                disabled={disabled}
                onChange={() => toggleMethod(index, method)}
                label={<span className="mono text-[11px]">{method}</span>}
              />
            ))}
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={disabled}
            title="Remove route"
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <p className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
        No method checked guards every method. <span className="mono">*</span> matches anything:{' '}
        <span className="mono">/rest/v1/*</span> is every table, <span className="mono">/api/edge/*</span> every function.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn" disabled={disabled} onClick={() => onChange([...value, { pathGlob: '' }])}>
          <Plus size={12} /> Add route
        </button>
        {tables.length > 0 && (
          <Select
            value=""
            label="table"
            ariaLabel="Guard a table's inserts"
            disabled={disabled}
            onChange={table => table && onChange([...value, { methods: ['POST'], pathGlob: `/rest/v1/${table}` }])}
            options={[{ value: '', label: 'Guard a table’s inserts…' }, ...tables.map(t => ({ value: t.name, label: t.name }))]}
          />
        )}
      </div>
    </div>
  );
}
