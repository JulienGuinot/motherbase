import { getErrorMessage } from '@/shared/lib/errors';
import { useState } from 'react';
import { Plus, ShieldOff, Trash2 } from 'lucide-react';
import type { RlsTable, PgPolicy } from '@/features/database/lib/rls-api';
import { rlsApi } from '@/features/database/lib/rls-api';
import { useToast } from '@/shared/lib/toast';
import { templates } from '@/features/database/lib/rls-templates';
import { EmptyState } from '@/shared/ui/EmptyState';

const COMMAND_TONE: Record<string, { color: string; bg: string }> = {
  SELECT: { color: 'var(--text-dim)', bg: 'var(--surface-2)' },
  INSERT: { color: 'var(--text-dim)', bg: 'var(--surface-2)' },
  UPDATE: { color: 'var(--text-dim)', bg: 'var(--surface-2)' },
  DELETE: { color: 'var(--text-dim)', bg: 'var(--surface-2)' },
  ALL: { color: 'var(--text-dim)', bg: 'var(--surface-2)' },
};

function CommandBadge({ command }: { command: string }) {
  const tone = COMMAND_TONE[command] ?? COMMAND_TONE.ALL;
  return (
    <span
      className="mono inline-flex w-[64px] shrink-0 justify-center px-1.5 py-1 text-[10px] font-semibold tracking-[0.08em]"
      style={{ color: tone.color, background: tone.bg, borderRadius: 'var(--radius-sm)' }}
    >
      {command}
    </span>
  );
}

export function RlsTableDetail({
  table,
  onChange,
  onNewPolicy,
  onEditPolicy,
}: {
  table: RlsTable;
  onChange: () => void;
  onNewPolicy: (templateId?: string) => void;
  onEditPolicy: (p: PgPolicy) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function toggleRls() {
    setBusy(true);
    try {
      await rlsApi.toggleRls(table.table, !table.rlsEnabled);
      toast.push({ kind: 'success', title: table.rlsEnabled ? 'RLS disabled' : 'RLS enabled' });
      onChange();
    } catch (err) {
      toast.push({ kind: 'error', title: 'Failed to toggle RLS', message: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function dropPolicy(name: string) {
    setBusy(true);
    try {
      await rlsApi.dropPolicy(table.table, name);
      toast.push({ kind: 'success', title: 'Policy deleted' });
      onChange();
    } catch (err) {
      toast.push({ kind: 'error', title: 'Failed to delete policy', message: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const count = table.policies.length;

  return (
    <section className="flex min-h-[420px] min-w-0 flex-1 flex-col overflow-hidden md:min-h-0">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-3 py-3 hairline sm:px-5 sm:py-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 className="text-[18px]" style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>{table.table}</h2>
          <span className="label">{count} {count === 1 ? 'policy' : 'policies'}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">

          <button className="btn btn-primary" disabled={busy} onClick={() => onNewPolicy()}>
            <Plus size={13} /> New policy
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={toggleRls}>
            {table.rlsEnabled ? 'Disable RLS' : 'Enable RLS'}
          </button>
        </div>
      </header>

      {!table.rlsEnabled && (
        <div className="flex items-center gap-2 px-5 py-2.5 text-[12px]" style={{ color: 'var(--text-mute)', background: 'color-mix(in srgb, var(--text-mute) 7%, transparent)' }}>
          <ShieldOff size={13} />
          RLS is disabled: this table is fully exposed through the API. Policies below do not apply until you enable it.
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {count === 0 ? (
          <EmptyState
            className="h-full"
            mascot="shield-keylock"
            title="No policies created yet"
            description={table.rlsEnabled
              ? <>RLS is <strong style={{ color: 'var(--accent)' }}>on</strong>: every non-admin request to <code className="mono">{table.table}</code> is denied until a policy allows it.</>
              : <>RLS is <strong style={{ color: 'var(--text-mute)' }}>off</strong>: <code className="mono">{table.table}</code> is fully exposed. Add a policy, then enable RLS to enforce it.</>}
            action={
              <button className="btn btn-primary" disabled={busy} onClick={() => onNewPolicy()}>
                <Plus size={13} /> Create policy
              </button>
            }
          >
            <div className="flex flex-col items-center gap-2">
              <span className="label text-[10px]">Or start from a template</span>
              <div className="flex flex-wrap justify-center gap-2">
                {templates.map(t => (
                  <button key={t.id} className="chip" title={t.description} disabled={busy} onClick={() => onNewPolicy(t.id)}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </EmptyState>
        ) : (
          <div className="divide-y divide-[var(--hairline)]">
            {table.policies.map(p => (
              <div
                key={p.name}
                role="button"
                tabIndex={0}
                onClick={() => onEditPolicy(p)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEditPolicy(p); } }}
                className="row-host flex cursor-pointer items-center gap-3 px-5 py-2.5 transition-colors hover:bg-[var(--hover)]"
              >
                <CommandBadge command={p.command} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px]">{p.name}</span>
                    {p.roles.map(r => <span key={r} className="chip" style={{ fontSize: 9 }}>{r}</span>)}
                  </div>
                  {(p.using || p.withCheck) && (
                    <code className="mono mt-0.5 block truncate text-[11px]" style={{ color: 'var(--paper-mute)' }}>
                      {p.using ? `USING (${p.using})` : ''}
                      {p.using && p.withCheck ? '  ·  ' : ''}
                      {p.withCheck ? `CHECK (${p.withCheck})` : ''}
                    </code>
                  )}
                </div>
                <button
                  className="btn btn-ghost row-actions"
                  style={{ color: 'var(--danger)' }}
                  disabled={busy}
                  onClick={e => { e.stopPropagation(); dropPolicy(p.name); }}
                  title="Delete policy"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
