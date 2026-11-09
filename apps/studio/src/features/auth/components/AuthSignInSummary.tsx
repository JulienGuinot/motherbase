import { useState } from 'react';
import { useProjectId } from '@/shared/hooks/useRouteParam';

import Link from 'next/link';
import { ArrowRight, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { useAuthStatus } from '@/features/auth/hooks/useAuthSettings';
import { StatusDot } from '@/shared/ui/Badge';
import { SummaryLine } from '@/features/auth/components/SummaryLine';
import { StatusRow } from '@/features/auth/components/StatusRow';

const PLUGIN_LABEL: Record<string, string> = { passkey: 'Passkeys', twoFactor: 'Multi-factor', apiKey: 'API keys', sso: 'SSO' };

// Where a half-configured item is actually fixed. Client IDs and secrets live in
// Providers, but the delivery transports (SMTP, Twilio) are settings groups.
export function fixTarget(item: { id: string; missing?: string[] }): { href: string; label: string } {
  const missing = item.missing ?? [];
  if (missing.some(m => m.startsWith('email.smtp.'))) return { href: '/settings#email.smtp', label: 'Set up SMTP' };
  if (missing.some(m => m === 'accountSid' || m === 'authToken' || m === 'from|messagingServiceSid'))
    return { href: '/settings#phone.sms', label: 'Set up SMS' };
  return { href: '/providers', label: 'Fix in Providers' };
}

// Compact, collapsible summary of the live sign-in surface. Sits above the users
// table on the merged Authentication page: a one-line recap of what is live, an
// actionable warning for anything half-configured, and a details drawer that
// reveals the full per-provider readiness list without stealing the spotlight
// from the users table. Single source of truth is /admin/auth/status, so this can
// never disagree with the Providers toggles or the running auth instance.
export function AuthSignInSummary() {
  const id = useProjectId();
  const base = `/p/${id}/auth`;
  const [open, setOpen] = useState(false);

  const statusQ = useAuthStatus();

  const items = statusQ.data?.items ?? [];
  const methodItems = items.filter(i => i.kind === 'method');
  const social = items.filter(i => i.kind === 'social');
  const plugins = items.filter(i => i.kind === 'plugin');
  const oauth = items.filter(i => i.kind === 'oauth');
  const needsConfig = items.filter(i => i.enabled && !i.configured);
  const fixTargets = Object.values(
    Object.fromEntries(needsConfig.map(i => { const t = fixTarget(i); return [t.href, t]; }))
  );

  const liveMethods = methodItems.filter(m => m.enabled).map(m => m.id);
  const liveSocial = social.filter(s => s.enabled && s.configured).map(s => s.id);
  const enabledPlugins = plugins.filter(p => p.enabled).map(p => PLUGIN_LABEL[p.id] ?? p.id);

  const enabledExtras = [...social, ...oauth, ...plugins].filter(i => i.enabled);
  const nothingEnabled = !statusQ.isLoading && liveMethods.length === 0 && enabledExtras.length === 0;

  return (
    <div className="card p-0">
      {/* Recap row: the whole strip toggles the details drawer. */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        {open ? <ChevronDown size={14} style={{ color: 'var(--text-mute)' }} /> : <ChevronRight size={14} style={{ color: 'var(--text-mute)' }} />}
        <span className="shrink-0 text-[11.5px]" style={{ color: 'var(--text-mute)' }}>Live sign-in</span>
        {statusQ.isLoading ? (
          <span className="shimmer h-4 w-40" />
        ) : (
          <div className="flex flex-1 flex-wrap items-center gap-1.5">
            {liveMethods.map(m => <span key={m} className="chip" style={{ color: 'var(--text-dim)' }}>{m}</span>)}
            {liveSocial.map(s => <span key={s} className="chip" style={{ color: 'var(--text-dim)' }}>{s}</span>)}
            {enabledPlugins.map(p => <span key={p} className="chip" style={{ color: 'var(--text-dim)' }}>{p}</span>)}
            {nothingEnabled && <span className="text-[12px]" style={{ color: 'var(--text-mute)' }}>Nothing enabled yet</span>}
          </div>
        )}
        <span className="ml-auto shrink-0 text-[11.5px]" style={{ color: 'var(--accent)' }}>{open ? 'Hide' : 'Details'}</span>
      </button>

      {/* Actionable warning: always visible, even when the drawer is closed. */}
      {needsConfig.length > 0 && (
        <div className="border-t hairline px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-2 text-[12px]" style={{ color: 'var(--amber)' }}>
            <AlertTriangle size={13} />
            <span style={{ fontWeight: 600 }}>{needsConfig.length} enabled {needsConfig.length === 1 ? 'provider needs' : 'providers need'} configuration</span>
            <span style={{ color: 'var(--text-mute)' }}>: {needsConfig.map(i => i.id).join(', ')}</span>
            {fixTargets.map(t => (
              <Link key={t.href} href={`${base}${t.href}`} className="inline-flex items-center gap-1" style={{ color: 'var(--accent)' }}>
                {t.label} <ArrowRight size={12} />
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Details drawer: the full per-provider readiness list. Green is ready;
          amber still needs required fields. Copy a callback URL into the
          provider's console. Kept collapsed so it stays signal, not noise. */}
      {open && (
        <div className="border-t hairline">
          <div className="space-y-3 px-5 pt-4">
            <SummaryLine label="Methods" values={liveMethods} empty="No native method enabled" />
            <SummaryLine label="Social" values={liveSocial} empty="No social provider live" providerBadges />
            <SummaryLine label="Plugins" values={enabledPlugins} empty="No plugins enabled" />
          </div>
          <div className="mt-3">
            {liveMethods.map(m => (
              <div key={m} className="flex items-center gap-3 border-t hairline px-5 py-2.5">
                <StatusDot tone="success" />
                <span className="text-[12.5px]" style={{ color: 'var(--text)' }}>{m}</span>
                <span className="chip" style={{ fontSize: 10, color: 'var(--text-mute)' }}>method</span>
                <span className="text-[11.5px]" style={{ color: 'var(--text-mute)' }}>Ready</span>
              </div>
            ))}
            {enabledExtras.map(i => <StatusRow key={`${i.kind}-${i.id}`} item={i} />)}
            {nothingEnabled && (
              <p className="border-t hairline px-5 py-6 text-center text-[12.5px]" style={{ color: 'var(--text-mute)' }}>
                Nothing enabled yet. Start in <Link href={`${base}/providers`} style={{ color: 'var(--accent)' }}>Sign In / Providers</Link>.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
