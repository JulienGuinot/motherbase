import { KeyRound, Trash2 } from 'lucide-react';
import type { Secret } from '@/features/api-tools/types';
import { EmptyState } from '@/shared/ui/EmptyState';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';

interface EdgeFunctionSecretsPanelProps {
  secrets: Secret[] | undefined;
  secretName: string;
  secretValue: string;
  saving: boolean;
  onNameChange: (value: string) => void;
  onValueChange: (value: string) => void;
  onSave: () => void;
  onDelete: (name: string) => void;
}

export function EdgeFunctionSecretsPanel({
  secrets,
  secretName,
  secretValue,
  saving,
  onNameChange,
  onValueChange,
  onSave,
  onDelete,
}: EdgeFunctionSecretsPanelProps) {
  return (
    <div className="flex min-h-[420px] flex-1 flex-col overflow-hidden md:min-h-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-3 hairline sm:px-5">
        <div>
          <span className="text-[13px]" style={{ fontWeight: 600 }}>Project secrets</span>
          <span className="ml-3 text-[11px]" style={{ color: 'var(--text-mute)' }}>
            Injected into every function as <code className="mono">env.NAME</code>
          </span>
        </div>
      </div>
      <div className="flex-1 space-y-6 overflow-auto p-3 sm:p-6">
        <div className="card flex flex-wrap items-end gap-3 p-4">
          <div className="flex flex-col gap-1">
            <span className="label">Name</span>
            <input
              value={secretName}
              onChange={event => onNameChange(event.target.value.toUpperCase())}
              placeholder="STRIPE_KEY"
              className="input mono w-48"
            />
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <span className="label">Value</span>
            <input
              type="password"
              value={secretValue}
              onChange={event => onValueChange(event.target.value)}
              placeholder="sk_live_…"
              className="input mono w-full"
            />
          </div>
          <button onClick={onSave} disabled={saving || !secretName.trim() || !secretValue} className="btn btn-primary">
            <KeyRound size={13} /> Save secret
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="console w-full">
            <thead><tr><th>Name</th><th>Value</th><th>Updated</th><th /></tr></thead>
            <tbody>
              {secrets?.map(secret => (
                <tr key={secret.id}>
                  <td className="mono text-[12px]">{secret.name}</td>
                  <td className="mono text-[12px]" style={{ color: 'var(--text-mute)' }}>{secret.preview}</td>
                  <td className="tabular-nums text-[11px]" style={{ color: 'var(--text-mute)' }}>{new Date(secret.updatedAt).toLocaleString()}</td>
                  <td className="text-right">
                    <button
                      onClick={async () => { if (await confirmDialog({ title: `Delete secret "${secret.name}"?`, description: 'Functions reading it will see it as undefined on the next invocation.', confirmLabel: 'Delete secret', tone: 'danger' })) onDelete(secret.name); }}
                      className="btn btn-ghost"
                      style={{ color: 'var(--danger)' }}
                      title="Delete"
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {secrets?.length === 0 && (
          <EmptyState title="No secrets yet" description="Add one above to expose it to this function at invocation time." />
        )}
      </div>
    </div>
  );
}
