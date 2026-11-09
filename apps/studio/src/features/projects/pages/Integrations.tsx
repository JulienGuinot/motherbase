'use client';

import { getErrorMessage } from '@/shared/lib/errors';
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Search, X } from 'lucide-react';
import { projectsApi } from '@/features/projects/api/projects.api';
import { useIntegrations } from '@/features/projects/hooks/useProjects';
import { useToast } from '@/shared/lib/toast';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { BrandLogo } from '@/shared/ui/BrandLogo';
import { EmptyState } from '@/shared/ui/EmptyState';
import { Skeleton } from '@/shared/ui/Skeleton';
import { IntegrationDrawer } from '@/features/projects/components/IntegrationDrawer';
import { IntegrationConnectModal as ConnectModal } from '@/features/projects/components/IntegrationConnectModal';
import { GitRepoCard } from '@/features/database/components/GitRepoCard';
import { CATEGORY_LABELS } from '@/features/projects/integrations.constants';
import type { Integration } from '@/features/projects/types';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';

const ALL = 'all';

/** One tile in the catalogue. */
function IntegrationTile({ integration, onOpen }: { integration: Integration; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="card group flex h-full flex-col gap-3 p-4 text-left transition-colors hover:border-(--border-strong)"
    >
      <div className="flex items-start gap-3">
        {/* A framed mark rather than a loose logo: the tiles line up even when a
            provider has no logo file and falls back to its initials. */}
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center"
          style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
        >
          <BrandLogo brand={integration.key} label={integration.name} size={22} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px]" style={{ color: 'var(--text)', fontWeight: 600 }}>
              {integration.name}
            </span>
            {integration.connected && <CheckCircle2 size={13} style={{ color: 'var(--green)', flexShrink: 0 }} />}
          </div>
          <div className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
            {CATEGORY_LABELS[integration.category] ?? integration.category}
          </div>
        </div>
      </div>

      <p className="line-clamp-2 flex-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
        {integration.description}
      </p>

      <div className="flex items-center justify-between">
        <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
          {integration.functions.length} function{integration.functions.length === 1 ? '' : 's'}
        </span>
        <span
          className="chip"
          style={integration.connected ? { color: 'var(--green)' } : { color: 'var(--accent)' }}
        >
          {integration.connected ? 'Connected' : 'Install'}
        </span>
      </div>
    </button>
  );
}

export default function Integrations() {
  const toast = useToast();
  const qc = useQueryClient();
  const [connecting, setConnecting] = useState<Integration | null>(null);
  const [selected, setSelected] = useState<Integration | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>(ALL);

  const listQ = useIntegrations();
  const integrations = useMemo(() => listQ.data ?? [], [listQ.data]);
  const connected = useMemo(() => integrations.filter(i => i.connected), [integrations]);

  // Keep the open drawer in sync after connect/disconnect refetches.
  const selectedLive = useMemo(
    () => (selected ? integrations.find(i => i.key === selected.key) ?? selected : null),
    [selected, integrations],
  );

  // Only the categories the catalogue actually has, so the filter never offers
  // a tab that yields nothing.
  const categories = useMemo(
    () => Array.from(new Set(integrations.map(i => i.category))).sort(),
    [integrations],
  );

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return integrations.filter(
      i =>
        (category === ALL || i.category === category) &&
        (!needle || i.name.toLowerCase().includes(needle) || i.description.toLowerCase().includes(needle)),
    );
  }, [integrations, category, query]);

  // Installing one template from the drawer is the same connect call with a
  // single route and no secrets: keys already stored are left untouched.
  const installFnM = useMutation({
    mutationFn: (args: { key: string; route: string }) =>
      projectsApi.connectIntegration(args.key, {}, true, [args.route]),
    onSuccess: (_r, args) => {
      qc.invalidateQueries({ queryKey: ['integrations'] });
      toast.push({ kind: 'success', title: `${args.route} installed` });
    },
    onError: e => toast.push({ kind: 'error', title: 'Install failed', message: getErrorMessage(e) }),
  });

  const disconnectM = useMutation({
    mutationFn: (args: { key: string; removeFunctions: boolean }) =>
      projectsApi.disconnectIntegration(args.key, args.removeFunctions),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['integrations'] });
      toast.push({ kind: 'success', title: 'Integration disconnected' });
    },
    onError: e => toast.push({ kind: 'error', title: 'Disconnect failed', message: getErrorMessage(e) }),
  });

  const filterPill = (value: string, label: string) => {
    const active = category === value;
    return (
      <button
        key={value}
        onClick={() => setCategory(value)}
        aria-pressed={active}
        className="border px-3 py-1.5 text-[12px] transition-colors"
        style={{
          borderRadius: 'var(--radius-sm)',
          background: active ? 'var(--surface-2)' : 'transparent',
          borderColor: active ? 'var(--accent)' : 'var(--border)',
          color: active ? 'var(--text)' : 'var(--text-mute)',
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <PageShell>
      <PageHeader
        title="Integrations"
        subtitle="Connect a third-party service and its prebuilt edge functions are installed with it. Keys are stored as project secrets."
        actions={
          <span className="chip">
            <CheckCircle2 size={11} style={{ color: 'var(--green)' }} /> {connected.length} of {integrations.length}{' '}
            connected
          </span>
        }
      />

      {/* Catalogue controls: search first, then the category row, the shape
          every app store uses and the thing this page was missing at twenty-one
          providers. */}
      <div className="space-y-3">
        <div
          className="flex items-center gap-2 border hairline-strong px-3 py-2"
          style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
        >
          <Search size={13} style={{ color: 'var(--text-mute)' }} />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search integrations…"
            className="w-full bg-transparent text-[13px] outline-none placeholder:opacity-50"
          />
          {query && (
            <button onClick={() => setQuery('')} title="Clear search" style={{ color: 'var(--text-mute)' }}>
              <X size={13} />
            </button>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {filterPill(ALL, `All · ${integrations.length}`)}
          {categories.map(key => filterPill(key, CATEGORY_LABELS[key] ?? key))}
        </div>
      </div>

      {listQ.isLoading && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-md" />
          ))}
        </div>
      )}

      {/* What is already wired up, before the catalogue of what is not. */}
      {!listQ.isLoading && connected.length > 0 && category === ALL && !query && (
        <div className="space-y-3">
          <div className="label">Installed</div>
          <div className="grid gap-3 rise-stagger sm:grid-cols-2 xl:grid-cols-3">
            {connected.map(integration => (
              <IntegrationTile
                key={integration.key}
                integration={integration}
                onOpen={() => setSelected(integration)}
              />
            ))}
          </div>
        </div>
      )}

      {!listQ.isLoading && (
        <div className="space-y-3">
          <div className="label">
            {category === ALL && !query ? 'Browse' : `${results.length} result${results.length === 1 ? '' : 's'}`}
          </div>

          {results.length === 0 ? (
            <div className="card">
              <EmptyState
                size="md"
                mascot="integrations"
                title="No integration matches"
                description="Try another name, or clear the category filter."
              />
            </div>
          ) : (
            <div className="grid gap-3 rise-stagger sm:grid-cols-2 xl:grid-cols-3">
              {(category === ALL && !query ? results.filter(i => !i.connected) : results).map(integration => (
                <IntegrationTile
                  key={integration.key}
                  integration={integration}
                  onOpen={() => setSelected(integration)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="space-y-3">
        <div className="label">Source control</div>
        <GitRepoCard />
      </div>

      {selectedLive && (
        <IntegrationDrawer
          integration={selectedLive}
          onClose={() => setSelected(null)}
          onConnect={() => {
            // The drawer and the modal share a z-50 layer, and the drawer is
            // portalled last, so leaving it open puts the panel on top of the
            // form the operator is typing into.
            setConnecting(selectedLive);
            setSelected(null);
          }}
          onInstallFunction={route => installFnM.mutate({ key: selectedLive.key, route })}
          installingRoute={installFnM.isPending ? installFnM.variables?.route : null}
          onDisconnect={async removeFunctions => {
            if (
              await confirmDialog({
                title: `Disconnect ${selectedLive.name}?`,
                description: `Its stored secrets are deleted${removeFunctions ? ' and its installed functions are removed' : ''}.`,
                confirmLabel: 'Disconnect',
                tone: 'danger',
              })
            ) {
              disconnectM.mutate({ key: selectedLive.key, removeFunctions });
            }
          }}
        />
      )}

      {connecting && (
        <ConnectModal
          integration={connecting}
          onClose={() => setConnecting(null)}
          onConnected={() => {
            setConnecting(null);
            qc.invalidateQueries({ queryKey: ['integrations'] });
          }}
        />
      )}
    </PageShell>
  );
}
