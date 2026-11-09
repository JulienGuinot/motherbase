'use client';

import { useMemo, useState } from 'react';
import { getErrorMessage } from '@/shared/lib/errors';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Power, PowerOff, Copy, Hash, Search, X } from 'lucide-react';
import { extensionsApi } from '@/features/database/api/extensions.api';
import { useExtensions } from '@/features/database/hooks/useExtensions';
import { useToast } from '@/shared/lib/toast';
import { ContextMenu } from '@/shared/ui/ContextMenu';
import { useContextMenu } from '@/shared/hooks/useContextMenu';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { Section } from '@/shared/ui/Section';
import { SkeletonList } from '@/shared/ui/Skeleton';
import { Toggle } from '@/shared/ui/Toggle';
import type { ExtInfo } from '@/features/database/types';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';

export default function Extensions() {
  const toast = useToast();
  const qc = useQueryClient();
  const extMenu = useContextMenu<ExtInfo>();

  const extQ = useExtensions();

  const enable = useMutation({
    mutationFn: (name: string) => extensionsApi.enable(name),
    onSuccess: (_, name) => {
      toast.push({ kind: 'success', title: 'Extension enabled', message: name });
      qc.invalidateQueries({ queryKey: ['pg-extensions'] });
    },
    onError: (err) => toast.push({ kind: 'error', title: 'Enable failed', message: getErrorMessage(err) }),
  });

  const disable = useMutation({
    mutationFn: (name: string) => extensionsApi.disable(name),
    onSuccess: (_, name) => {
      toast.push({ kind: 'success', title: 'Extension disabled', message: name });
      qc.invalidateQueries({ queryKey: ['pg-extensions'] });
    },
    onError: (err) => toast.push({ kind: 'error', title: 'Disable failed', message: getErrorMessage(err) }),
  });

  const [query, setQuery] = useState('');

  const { enabled, available } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (extQ.data ?? []).filter(
      ext => !needle || ext.name.toLowerCase().includes(needle) || ext.comment.toLowerCase().includes(needle)
    );
    return {
      enabled: matches.filter(ext => ext.installed),
      available: matches.filter(ext => !ext.installed),
    };
  }, [extQ.data, query]);

  const busy = enable.isPending || disable.isPending;

  const toggle = async (ext: ExtInfo) => {
    if (!ext.installed) return enable.mutate(ext.name);
    if (
      await confirmDialog({
        title: `Disable extension "${ext.name}"?`,
        description: 'Objects created by the extension stop working until it is enabled again.',
        confirmLabel: 'Disable',
        tone: 'danger',
      })
    )
      disable.mutate(ext.name);
  };

  /**
   * One line per extension. The page used to be seventy identical cards, each
   * carrying the same elephant and a full-width orange button, which made an
   * on/off list read as seventy calls to action and hid which ones were on.
   */
  const row = (ext: ExtInfo) => (
    <div
      key={ext.name}
      onContextMenu={e => extMenu.onContextMenu(e, ext)}
      className="flex items-center gap-4 border-t hairline px-5 py-2.5 first:border-t-0 hover:bg-(--hover)"
    >
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <span className="mono shrink-0 text-[12.5px]" style={{ color: 'var(--text)' }}>
          {ext.name}
        </span>
        {ext.installed && (
          <span className="chip tabular-nums shrink-0" style={{ color: 'var(--green)' }}>
            v{ext.installedVersion}
          </span>
        )}
        <span className="truncate text-[11.5px]" style={{ color: 'var(--text-mute)' }} title={ext.comment}>
          {ext.comment || 'No description'}
        </span>
      </div>

      <Toggle
        checked={ext.installed}
        onChange={() => toggle(ext)}
        disabled={busy}
        ariaLabel={`${ext.installed ? 'Disable' : 'Enable'} ${ext.name}`}
      />
    </div>
  );

  return (
    <PageShell width="wide">
      <PageHeader
        title="Extensions"
        subtitle="Enable PostgreSQL extensions for your database."
        actions={
          <div
            className="flex w-[min(320px,60vw)] items-center gap-2 border hairline-strong px-3 py-1.5"
            style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
          >
            <Search size={12} style={{ color: 'var(--text-mute)' }} />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search extensions…"
              className="w-full bg-transparent text-[13px] outline-none placeholder:opacity-50"
            />
            {query && (
              <button onClick={() => setQuery('')} title="Clear" style={{ color: 'var(--text-mute)' }}>
                <X size={12} />
              </button>
            )}
          </div>
        }
      />

      {extQ.isLoading && <SkeletonList rows={10} height={34} className="card p-4" />}

      {!extQ.isLoading && (
        <>
          <Section
            title={`Enabled · ${enabled.length}`}
            description={enabled.length === 0 ? 'No extension is enabled in this database yet.' : undefined}
            flush
          >
            {enabled.length > 0 && <div>{enabled.map(row)}</div>}
          </Section>

          <Section title={`Available · ${available.length}`} flush>
            {available.length > 0 ? (
              <div>{available.map(row)}</div>
            ) : (
              <p className="px-5 py-4 text-[12px]" style={{ color: 'var(--text-mute)' }}>
                Nothing matches “{query}”.
              </p>
            )}
          </Section>
        </>
      )}

      {extMenu.menu && (
        <ContextMenu
          x={extMenu.menu.x}
          y={extMenu.menu.y}
          onClose={extMenu.close}
          items={[
            {
              label: extMenu.menu.data.installed ? 'Disable extension' : 'Enable extension',
              icon: extMenu.menu.data.installed ? <PowerOff size={13} /> : <Power size={13} />,
              danger: extMenu.menu.data.installed,
              action: async () => {
                const ext = extMenu.menu!.data;
                if (ext.installed) {
                  if (await confirmDialog({ title: `Disable extension "${ext.name}"?`, description: 'Objects created by the extension stop working until it is enabled again.', confirmLabel: 'Disable', tone: 'danger' })) disable.mutate(ext.name);
                } else {
                  enable.mutate(ext.name);
                }
              },
            },
            { type: 'separator' as const },
            {
              label: 'Copy name',
              icon: <Hash size={13} />,
              action: () => {
                navigator.clipboard.writeText(extMenu.menu!.data.name);
                toast.push({ kind: 'success', title: 'Name copied' });
              },
            },
            {
              label: 'Copy CREATE EXTENSION',
              icon: <Copy size={13} />,
              action: () => {
                navigator.clipboard.writeText(`CREATE EXTENSION IF NOT EXISTS "${extMenu.menu!.data.name}";`);
                toast.push({ kind: 'success', title: 'SQL copied' });
              },
            },
          ]}
        />
      )}
    </PageShell>
  );
}
