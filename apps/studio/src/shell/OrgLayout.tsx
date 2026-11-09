'use client';

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { NavLink } from '@/shared/ui/NavLink';
import { FolderOpen, Users, Gauge, CreditCard, Settings, Plus, type LucideIcon, ScrollText } from 'lucide-react';
import TwoFactorNudge from '@/features/platform/components/TwoFactorNudge';
import OrgSwitcher from '@/shared/ui/OrgSwitcher';
import MobileNav from '@/shared/ui/MobileNav';
import Logo from '@/shared/ui/Logo';
import {
  hasPlatformCapability,
  usePlatformMe,
} from '@/features/platform/hooks/usePlatformAccess';
import type { PlatformCapability } from '@/shared/lib/api';
import { usePlatformFeatures } from '@/features/platform/hooks/usePlatformFeatures';

// Organization-level shell for the pre-project area: a left sidebar (Projects /
// Team / Usage / Billing / Settings) mirroring the per-project product nav, with
// each section routed into the outlet. Parity with the Supabase org sidebar.
const ITEMS: {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  capability?: PlatformCapability;
  /** Console feature flag this item depends on. Absent means always shown. */
  feature?: 'billing';
}[] = [
  { to: '/', label: 'Projects', icon: FolderOpen, end: true },
  { to: '/team', label: 'Team', icon: Users, capability: 'users.manage' },
  { to: '/usage', label: 'Usage', icon: Gauge },
  { to: '/logs', label: 'Logs', icon: ScrollText },
  { to: '/billing', label: 'Billing', icon: CreditCard, feature: 'billing' },
  { to: '/settings', label: 'Org settings', icon: Settings },
];

export default function OrgLayout({ children }: { children: ReactNode }) {
  const nav = useRouter();
  const meQuery = usePlatformMe();
  const canCreateProject = hasPlatformCapability(meQuery.data, 'project.create');
  const features = usePlatformFeatures();
  const visibleItems = ITEMS.filter(
    item =>
      (!item.capability || hasPlatformCapability(meQuery.data, item.capability)) &&
      (!item.feature || features[item.feature])
  );
  return (
    <div className="relative flex h-dvh overflow-hidden" style={{ background: 'var(--bg)' }}>
      <aside className="hidden h-dvh w-56 shrink-0 flex-col border-r hairline md:flex" style={{ background: 'var(--ink-2, var(--surface-1))' }}>
        <div className="flex items-center gap-2 border-b hairline px-3 py-3.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border hairline" style={{ background: 'var(--surface-2)' }}>
            <Logo size={18} />
          </span>
          <OrgSwitcher />
        </div>

        <nav className="flex-1 overflow-auto p-2">
          {visibleItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              href={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors ${
                  isActive ? 'font-medium' : ''
                }`
              }
              style={({ isActive }) => ({
                color: isActive ? 'var(--text)' : 'var(--text-dim)',
                background: isActive ? 'var(--surface-2)' : 'transparent',
              })}
            >
              <Icon size={15} /> {label}
            </NavLink>
          ))}
        </nav>

        {canCreateProject && (
          <div className="border-t hairline p-3">
            <button onClick={() => nav.push('/new')} className="btn btn-primary w-full justify-center">
              <Plus size={14} /> New project
            </button>
          </div>
        )}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-auto pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">
        <div className="flex items-center gap-2 border-b p-3 hairline md:hidden">
          <span className="min-w-0 flex-1"><OrgSwitcher /></span>
          {canCreateProject && (
            <button onClick={() => nav.push('/new')} className="btn btn-primary shrink-0" aria-label="New project">
              <Plus size={14} />
            </button>
          )}
        </div>
        <TwoFactorNudge />
        {children}
      </main>

      {/* Outside <main>: the pill is absolute against this shell, and must not
          scroll away with the page. */}
      <MobileNav
        title="Organization"
        items={visibleItems.map(({ to, label, icon, end }) => ({ href: to, label, icon, end }))}
      />
    </div>
  );
}
