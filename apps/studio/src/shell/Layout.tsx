'use client';

import type { ReactNode } from 'react';
import { getErrorMessage } from '@/shared/lib/errors';
import { useProjectId } from '@/shared/hooks/useRouteParam';
import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  Terminal,
  ArrowLeft,
  LogOut,
  Search,
  Moon,
  Sun,
} from 'lucide-react';
import { useSignOut } from '@/shared/hooks/useSignOut';
import { platform } from '@/shared/lib/api';
import { usePreferences } from '@/shared/lib/theme';
import { useToast } from '@/shared/lib/toast';
import CommandPalette from '@/shared/ui/CommandPalette';
import { FetchProgress } from '@/shared/ui/FetchProgress';
import ProjectSwitcher from '@/shared/ui/ProjectSwitcher';
import BranchSwitcher from '@/features/projects/components/BranchSwitcher';
import NavRail from '@/shared/ui/NavRail';
import MobileNav from '@/shared/ui/MobileNav';
import OrgSwitcher from '@/shared/ui/OrgSwitcher';
import { PRODUCTS, segmentLabel } from '@/shared/lib/nav';
import { OnboardingTour } from '@/shared/ui/OnboardingTour';
import { PROJECT_TOUR_STEPS, hasSeenProjectOnboarding } from '@/shared/lib/onboarding';
import { hasPlatformCapability, usePlatformMe } from '@/features/platform/hooks/usePlatformAccess';
import AssistantDock from '@/features/assistant/components/AssistantDock';

export default function Layout({ children }: { children: ReactNode }) {
  const navigate = useRouter();
  const signOut = useSignOut();
  const location = { pathname: usePathname() ?? '' };
  const id = useProjectId();
  const { resolvedTheme, toggle } = usePreferences();
  const toast = useToast();
  const projectBase = id ? `/p/${id}` : '';
  const platformMeQ = usePlatformMe();
  const canManageRuntime = hasPlatformCapability(platformMeQ.data, 'runtime.manage');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shellBusy, setShellBusy] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(() => !hasSeenProjectOnboarding());

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const crumbs = useMemo(() => {
    const parts = location.pathname.split('/').filter(Boolean);
    const projectScoped = parts[0] === 'p' && parts[1];
    const base = projectScoped ? parts.slice(0, 2) : [];
    const visible = projectScoped ? parts.slice(2) : parts;
    return visible.map((p, i) => ({
      label: segmentLabel(p, visible[i - 1]),
      path: '/' + [...base, ...visible.slice(0, i + 1)].join('/'),
    }));
  }, [location.pathname]);

  const copyProjectShell = async () => {
    if (!id || shellBusy) return;
    setShellBusy(true);
    try {
      const shell = await platform.projectShell(id);
      await navigator.clipboard.writeText(shell.command);
      toast.push({ kind: 'success', title: 'Shell command copied' });
    } catch (err) {
      toast.push({ kind: 'error', title: getErrorMessage(err, 'Shell unavailable') });
    } finally {
      setShellBusy(false);
    }
  };

  return (
    <div className="relative flex h-dvh overflow-hidden" style={{ background: 'var(--bg)' }}>
      <NavRail />

      <div className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header
          className="sticky top-0 z-20 flex items-center gap-2 border-b px-3 sm:gap-4 sm:px-5"
          style={{ height: 56, background: 'var(--bg)', borderColor: 'var(--border)' }}
        >
          <FetchProgress />
          <nav className="flex min-w-0 items-center gap-2 overflow-hidden text-[13px]" style={{ color: 'var(--text-dim)' }}>
            {/* Root crumb: leaves the project and returns to the Platform Console
               home. The org switcher slots in between here and ProjectSwitcher. */}
            <button
              onClick={() => navigate.push('/')}
              className="hidden items-center gap-1.5 hover:underline lg:flex"
              style={{ color: 'var(--text-mute)' }}
              title="Back to the Platform Console"
            >
              <span>Motherbase</span>
            </button>
            <span className="hidden lg:inline" style={{ color: 'var(--text-mute)' }}>/</span>
            <span className="hidden lg:block"><OrgSwitcher compact /></span>
            <span className="hidden lg:inline" style={{ color: 'var(--text-mute)' }}>/</span>
            <span className="min-w-0 max-w-[120px] sm:max-w-[220px]"><ProjectSwitcher /></span>
            <span className="hidden min-w-0 max-w-[200px] md:block"><BranchSwitcher /></span>
            <span className="hidden sm:inline" style={{ color: 'var(--text-mute)' }}>/</span>
            {crumbs.length === 0 ? (
              <span className="hidden sm:inline" style={{ color: 'var(--text)' }}>Overview</span>
            ) : (
              crumbs.map((c, i) => (
                <span key={c.path} className={`${i === crumbs.length - 1 ? 'hidden sm:flex' : 'hidden lg:flex'} items-center gap-2`}>
                  <button onClick={() => navigate.push(c.path)} className="hover:underline"
                    style={{ color: i === crumbs.length - 1 ? 'var(--text)' : 'var(--text-mute)' }}>
                    {c.label}
                  </button>
                  {i < crumbs.length - 1 && <span style={{ color: 'var(--text-mute)' }}>/</span>}
                </span>
              ))
            )}
          </nav>

          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={() => setPaletteOpen(true)}
              className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px]"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text-mute)' }}>
              <Search size={14} />
              <span className="hidden sm:inline">Search</span>
              <kbd className="hidden lg:inline">⌘K</kbd>
            </button>
            {id && canManageRuntime && (
              <button onClick={copyProjectShell} disabled={shellBusy} className="btn btn-ghost hidden sm:inline-flex" title="Copy project shell command">
                <Terminal size={15} />
              </button>
            )}
            <button onClick={toggle} className="btn btn-ghost" title="Toggle theme" aria-label="Toggle theme">
              {resolvedTheme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            <button onClick={signOut} className="btn btn-ghost" title="Sign out">
              <LogOut size={15} />
            </button>
          </div>
        </header>

        {/* Bottom padding on phones keeps the end of every page clear of the
            fixed navigation pill. */}
        <main className="flex flex-1 min-h-0 flex-col overflow-y-auto overflow-x-hidden pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">
          {children}
        </main>

      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {showOnboarding && (
        <OnboardingTour steps={PROJECT_TOUR_STEPS} storageKey="project" onClose={() => setShowOnboarding(false)} />
      )}
      <AssistantDock
        mobileNav={assistantLauncher => (
          <MobileNav
            title="Motherbase"
            items={PRODUCTS.map(p => ({ href: `${projectBase}${p.base}`, label: p.label, icon: p.icon }))}
            footer={
              <button
                onClick={() => navigate.push('/')}
                className="flex w-full items-center gap-2 text-[13px]"
                style={{ color: 'var(--text-dim)' }}
              >
                <ArrowLeft size={15} /> All projects
              </button>
            }
            action={assistantLauncher}
          />
        )}
      />
    </div>
  );
}
