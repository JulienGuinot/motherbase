'use client';

import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { Field } from '@/shared/ui/Field';
import Select from '@/shared/ui/Select';
import type { ConfigChange, ConfigScope, PostgresSetting } from '@/features/database/api/catalog.api';

const SCOPE_LABEL: Record<ConfigScope, string> = {
  database: 'This database (new sessions)',
  role: 'One role in this database',
  system: 'Server-wide (ALTER SYSTEM)',
};

/** What a value means, with its unit: `work_mem` is counted in kB, `shared_buffers` in 8kB pages. */
function unitHint(setting: PostgresSetting): string {
  const range = setting.min !== null && setting.max !== null ? ` Range ${setting.min} to ${setting.max}${setting.unit ? ` ${setting.unit}` : ''}.` : '';
  return `Current: ${setting.value}. A bare number is in ${setting.unit ?? 'the setting’s own unit'}; suffixes such as 64MB or 30s work too.${range}`;
}

export function PostgresSettingModal({ setting, roles, canAlterSystem, saving, onApply, onClose }: {
  setting: PostgresSetting;
  roles: string[];
  canAlterSystem: boolean;
  saving: boolean;
  onApply: (changes: ConfigChange[]) => void;
  onClose: () => void;
}) {
  const scopes = setting.scopes.filter(scope => scope !== 'system' || canAlterSystem);
  const [scope, setScope] = useState<ConfigScope>(scopes[0] ?? 'system');
  const [role, setRole] = useState(roles[0] ?? '');
  const [value, setValue] = useState(setting.value);
  const choices = setting.vartype === 'bool' ? ['on', 'off'] : setting.enumValues;

  const apply = () => onApply([{ name: setting.name, value: value.trim(), scope, ...(scope === 'role' ? { role } : {}) }]);

  return (
    <Modal onClose={onClose}>
      <ModalHeader eyebrow={setting.category} title={setting.name} description={setting.description} />
      <ModalBody className="space-y-4">
        {setting.context === 'postmaster' && (
          <p className="text-[12px]" style={{ color: 'var(--amber)' }}>
            Takes effect only after Postgres restarts. Motherbase does not restart it for you.
          </p>
        )}
        {!scopes.length && (
          <p className="text-[12px]" style={{ color: 'var(--red)' }}>
            Only ALTER SYSTEM can change this, and the server does not connect as a superuser.
          </p>
        )}

        <Field label="Value" hint={choices ? undefined : unitHint(setting)}>
          {choices ? (
            <Select value={value} onChange={setValue} ariaLabel="Value" options={choices.map(choice => ({ value: choice, label: choice }))} className="w-full" />
          ) : (
            <input className="input mono w-full" value={value} onChange={event => setValue(event.target.value)} autoFocus />
          )}
        </Field>

        {scopes.length > 0 && (
          <Field label="Apply to">
            <Select
              value={scope}
              onChange={next => setScope(next as ConfigScope)}
              ariaLabel="Scope"
              options={scopes.map(option => ({ value: option, label: SCOPE_LABEL[option] }))}
              className="w-full"
            />
          </Field>
        )}
        {scope === 'role' && (
          <Field label="Role">
            <Select value={role} onChange={setRole} ariaLabel="Role" options={roles.map(name => ({ value: name, label: name }))} className="w-full" />
          </Field>
        )}

        {setting.overrides.length > 0 && (
          <Field label="Current overrides">
            <div className="space-y-1.5">
              {setting.overrides.map(override => (
                <div key={`${override.scope}:${override.role ?? ''}`} className="flex items-center justify-between gap-3 text-[12px]">
                  <span>
                    <span className="mono">{override.value}</span>
                    <span style={{ color: 'var(--text-mute)' }}> · {override.scope}{override.role ? ` (${override.role})` : ''}</span>
                  </span>
                  <button
                    className="btn btn-ghost"
                    disabled={saving || (override.scope === 'system' && !canAlterSystem)}
                    onClick={() => onApply([{ name: setting.name, value: null, scope: override.scope, ...(override.role ? { role: override.role } : {}) }])}
                  >
                    <RotateCcw size={12} /> Reset
                  </button>
                </div>
              ))}
            </div>
          </Field>
        )}
      </ModalBody>
      <ModalFooter>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={saving || !scopes.length || !value.trim() || (scope === 'role' && !role)} onClick={apply}>
          Apply
        </button>
      </ModalFooter>
    </Modal>
  );
}
