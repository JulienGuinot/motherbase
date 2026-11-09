'use client';

import { Save } from 'lucide-react';
import { Field } from '@/shared/ui/Field';
import { SkeletonList } from '@/shared/ui/Skeleton';
import { Toggle } from '@/shared/ui/Toggle';
import { WriteButton } from '@/shared/ui/WriteButton';
import type { BackupConfig } from '@/features/database/types';

/** Cron schedule, retention and off-site copy, saved as one config object. */
export function BackupScheduleCard({
  config,
  isLoading,
  dirty,
  saving,
  onChange,
  onSave,
}: {
  config: BackupConfig | null;
  isLoading: boolean;
  dirty: boolean;
  saving: boolean;
  onChange: (config: BackupConfig) => void;
  onSave: () => void;
}) {
  if (isLoading || !config) return <SkeletonList rows={3} className="card p-4" />;

  return (
    <div className="card space-y-5 p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[14px] font-medium">Scheduled backups</div>
          <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-mute)' }}>
            Run automatically on a cron schedule and prune older snapshots by retention count.
          </p>
        </div>
        <Toggle
          checked={config.enabled}
          onChange={v => onChange({ ...config, enabled: v })}
          ariaLabel={config.enabled ? 'Disable schedule' : 'Enable schedule'}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <div className="label mb-1">
            Schedule
            <span className="ml-2 font-normal" style={{ color: 'var(--text-mute)' }}>
              cron
            </span>
          </div>
          <input
            value={config.cron}
            onChange={e => onChange({ ...config, cron: e.target.value })}
            placeholder="0 3 * * *"
            className="input mono"
            disabled={!config.enabled}
          />
        </div>

        <Field label="Retention">
          <input
            type="number"
            min={1}
            value={config.retention}
            onChange={e => onChange({ ...config, retention: Number(e.target.value) })}
            placeholder="7"
            className="input mono"
            disabled={!config.enabled}
          />
        </Field>

        <Field label="Off-site copy">
          <div
            className="flex w-full items-center justify-between gap-2.5 rounded-md border px-3 py-2 text-[13px]"
            style={{
              borderColor: 'var(--border)',
              background: 'var(--surface-2)',
              color: config.offsite ? 'var(--text)' : 'var(--text-mute)',
            }}
          >
            <span>{config.offsite ? 'Enabled' : 'Disabled'}</span>
            <Toggle
              checked={config.offsite}
              onChange={v => onChange({ ...config, offsite: v })}
              ariaLabel="Off-site copy"
              disabled={!config.enabled}
            />
          </div>
        </Field>
      </div>

      <div className="flex justify-end">
        <WriteButton
          capability="settings.write"
          onClick={onSave}
          disabled={!dirty || saving}
          className="btn btn-primary"
        >
          <Save size={12} /> {saving ? 'Saving…' : 'Save settings'}
        </WriteButton>
      </div>
    </div>
  );
}
