import { useState } from 'react';
import { useProjectId } from '@/shared/hooks/useRouteParam';
import { useRouter } from 'next/navigation';
import { ExternalLink, KeyRound, Plug, Trash2, Zap, BookOpen } from 'lucide-react';
import DetailDrawer, { type DrawerTab } from '@/shared/ui/DetailDrawer';
import { BrandLogo } from '@/shared/ui/BrandLogo';
import type { Integration } from '@/features/projects/types';
import { EmptyState } from '@/shared/ui/EmptyState';

export function IntegrationDrawer({
  integration,
  onClose,
  onConnect,
  onDisconnect,
  onInstallFunction,
  installingRoute,
}: {
  integration: Integration;
  onClose: () => void;
  onConnect: () => void;
  onDisconnect: (removeFunctions: boolean) => void;
  /** Install one template without reopening the connect flow. */
  onInstallFunction: (route: string) => void;
  installingRoute?: string | null;
}) {
  const navigate = useRouter();
  const id = useProjectId();
  const [tab, setTab] = useState<'overview' | 'functions'>('overview');

  const avatar = <BrandLogo brand={integration.key} label={integration.name} size={44} />;

  const tabs: DrawerTab[] = [
    { id: 'overview', label: 'Overview', icon: KeyRound },
    { id: 'functions', label: `Functions · ${integration.functions.length}`, icon: Zap },
  ];

  const footer = (
    <div className="space-y-2">
      <button onClick={onConnect} className="btn btn-primary w-full justify-center">
        <Plug size={12} /> {integration.connected ? 'Update keys / reinstall' : 'Connect'}
      </button>
      {integration.connected && (
        <button
          onClick={() => onDisconnect(true)}
          className="btn w-full justify-center"
          style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
        >
          <Trash2 size={12} /> Disconnect
        </button>
      )}
    </div>
  );

  return (
    <DetailDrawer
      title={integration.name}
      subtitle={integration.connected ? 'Connected' : 'Not connected'}
      avatar={avatar}
      tabs={tabs}
      activeTab={tab}
      onTab={t => setTab(t as 'overview' | 'functions')}
      onClose={onClose}
      footer={footer}
      width="30rem"
    >
      {tab === 'overview' ? (
        <div className="space-y-5">
          <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>{integration.description}</p>
          <div>
            <div className="label mb-2">Required keys</div>
            <div className="space-y-2">
              {integration.secrets.map(s => (
                <div key={s.name} className="flex items-center gap-2 border hairline p-2.5" style={{ borderRadius: 'var(--radius-sm)' }}>
                  <KeyRound size={13} style={{ color: s.set ? 'var(--green)' : 'var(--text-mute)', flexShrink: 0 }} />
                  <div className="min-w-0 flex-1">
                    <div className="mono truncate text-[11px]">{s.name}</div>
                    <div className="text-[10px]" style={{ color: 'var(--text-mute)' }}>{s.label}{s.optional ? ' (optional)' : ''}</div>
                  </div>
                  <span className="chip" style={s.set ? { color: 'var(--green)', borderColor: 'var(--green)' } : undefined}>
                    {s.set ? 'Set' : 'Missing'}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <a
            href={integration.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-[12px] hover:underline"
            style={{ color: 'var(--accent)' }}
          >
            <BookOpen size={12} /> API docs <ExternalLink size={10} />
          </a>
        </div>
      ) : (
        <div className="space-y-2">
          {integration.functions.map(fn => (
            <div key={fn.route} className="border hairline p-3" style={{ borderRadius: 'var(--radius-sm)' }}>
              <div className="flex items-center gap-2">
                <Zap size={13} style={{ color: fn.installed ? 'var(--accent)' : 'var(--text-mute)', flexShrink: 0 }} />
                <span className="mono flex-1 truncate text-[12px]">{fn.name}</span>
                {fn.kind === 'webhook' && <span className="chip" style={{ fontSize: 10 }}>Webhook</span>}
                {fn.readiness === 'example' && (
                  <span className="chip" style={{ color: 'var(--warning)', borderColor: 'var(--warning)' }}>Example</span>
                )}
                {fn.schedule && <span className="chip mono" style={{ fontSize: 10 }}>{fn.schedule}</span>}
                {fn.installed ? (
                  <button
                    onClick={() => navigate.push(`/p/${id}/edge-functions`)}
                    className="chip hover:underline"
                    style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}
                    title="Open in Edge Functions"
                  >
                    Installed →
                  </button>
                ) : (
                  <button
                    onClick={() => onInstallFunction(fn.route)}
                    disabled={installingRoute === fn.route}
                    className="chip hover:underline"
                    style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}
                    title="Install this function"
                  >
                    {installingRoute === fn.route ? 'Installing…' : 'Install'}
                  </button>
                )}
              </div>
              <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-mute)' }}>{fn.description}</p>
            </div>
          ))}
          {integration.functions.length === 0 && (
            <EmptyState title="No template functions" description="This integration ships no starter functions." />
          )}
        </div>
      )}
    </DetailDrawer>
  );
}
