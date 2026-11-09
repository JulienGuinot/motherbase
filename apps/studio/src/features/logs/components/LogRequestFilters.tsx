'use client';

import { X } from 'lucide-react';
import Select from '@/shared/ui/Select';
import type { LogRequestFilters as Filters } from '@/features/logs/types';

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
const STATUS_FORMAT = /^\s*(?:[1-5]xx|\d{3}(?:-\d{3})?)(?:\s*,\s*(?:[1-5]xx|\d{3}(?:-\d{3})?))*\s*$/i;

/** Whether a status filter is one the server will accept; an empty one always is. */
export function isValidStatusFilter(value: string | undefined): boolean {
  return !value?.trim() || STATUS_FORMAT.test(value);
}

/**
 * Status, method, path and user: the request-shaped filters of the Logs
 * Explorer. Applied by the server (see lib/log-filter on the API), so they
 * reach history the stream has not loaded.
 */
export function LogRequestFilters({ value, onChange }: { value: Filters; onChange: (next: Filters) => void }) {
  const set = (patch: Filters) => onChange({ ...value, ...patch });
  const active = Object.values(value).some(Boolean);
  const statusValid = isValidStatusFilter(value.status);

  return (
    <div className="card flex flex-wrap items-end gap-3 p-3">
      <label className="flex flex-col gap-1">
        <span className="label">Status</span>
        <input
          className="input mono w-32"
          placeholder="5xx, 404"
          value={value.status ?? ''}
          aria-invalid={!statusValid}
          style={statusValid ? undefined : { borderColor: 'var(--danger)' }}
          onChange={event => set({ status: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Method</span>
        <Select
          value={value.method ?? ''}
          onChange={method => set({ method })}
          ariaLabel="Method"
          style={{ width: 110 }}
          options={[{ value: '', label: 'Any' }, ...METHODS.map(method => ({ value: method, label: method }))]}
        />
      </label>
      <label className="flex min-w-[180px] flex-1 flex-col gap-1">
        <span className="label">Path</span>
        <input className="input mono w-full" placeholder="/rest/v1/todos" value={value.path ?? ''} onChange={event => set({ path: event.target.value })} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">User</span>
        <input className="input mono w-56" placeholder="user id" value={value.user ?? ''} onChange={event => set({ user: event.target.value })} />
      </label>
      {active && (
        <button className="btn btn-ghost" onClick={() => onChange({})}>
          <X size={12} /> Clear
        </button>
      )}
    </div>
  );
}
