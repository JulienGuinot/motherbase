import { useState } from 'react';
import { useProjectId } from '@/shared/hooks/useRouteParam';
import { usePathname } from 'next/navigation';
import { NavLink } from '@/shared/ui/NavLink';
import { PanelLeft, PanelLeftClose, PanelLeftOpen, Check, ArrowUpCircle } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { PRODUCTS, resolveProduct } from '@/shared/lib/nav';
import { useSidebar, type SidebarMode } from '@/shared/lib/sidebar';
import { platform } from '@/shared/lib/api';
import { Mascot } from './Mascot';

const RAIL = 52;
const WIDE = 220;

// Thin icon rail (Supabase-style). Collapsible: expands to show labels either
// permanently or on hover, controlled by a persisted preference. The contextual
// panel (if any) is rendered by ProductLayout.
export default function NavRail() {
  const id = useProjectId();
  const location = { pathname: usePathname() ?? '' };
  const projectBase = id ? `/p/${id}` : '';
  const active = resolveProduct(location.pathname);
  const { mode } = useSidebar();

  const [hovered, setHovered] = useState(false);

  const expanded = mode === 'expanded' || (mode === 'hover' && hovered);
  // Footprint reserved in layout. Hover mode overlays, so it stays thin.
  const footprint = mode === 'expanded' ? WIDE : RAIL;

  const main = PRODUCTS.filter(p => p.placement !== 'bottom');
  const bottom = PRODUCTS.filter(p => p.placement === 'bottom');

  const renderItem = (key: string, label: string, base: string, Icon: typeof PRODUCTS[number]['icon']) => {
    const isActive = active?.key === key;
    return (
      <li key={key} data-tour={`nav-${base.slice(1)}`}>
        <NavLink
          href={`${projectBase}${base}`}
          title={expanded ? undefined : label}
          aria-current={isActive ? 'page' : undefined}
          className="block"
        >
          <span
            className="nav-item relative mx-1.5 flex h-9 items-center gap-2.5 rounded-md px-2.5"
            data-active={isActive}
            style={{ color: isActive ? 'var(--accent)' : 'var(--text-dim)' }}
          >
            {isActive && (
              <span
                className="absolute left-[-6px] top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r"
                style={{ background: 'var(--accent)' }}
              />
            )}
            <Icon size={18} color={isActive ? 'var(--accent)' : 'currentColor'} />
            {expanded && (
              <span className="truncate text-[13px]" style={{ color: isActive ? 'var(--text)' : 'inherit' }}>
                {label}
              </span>
            )}
          </span>
        </NavLink>
      </li>
    );
  };

  return (
    <div className="relative hidden shrink-0 md:block" style={{ width: footprint }}>
      <aside
        className="fixed left-[env(safe-area-inset-left)] top-0 z-30 hidden h-dvh flex-col border-r transition-[width] duration-150 ease-out md:flex"
        style={{
          width: expanded ? WIDE : RAIL,
          background: 'var(--surface)',
          borderColor: 'var(--border)',
          boxShadow: mode === 'hover' && hovered ? '4px 0 16px rgba(0,0,0,0.12)' : 'none',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div
          className="flex items-center gap-2.5 border-b px-2.5"
          style={{ height: 56, borderColor: 'var(--border)' }}
        >
          <Mascot name='logo' size={60} />
          {expanded && <span className="truncate text-[13px] font-semibold" style={{ color: 'var(--text)' }}>Motherbase</span>}
        </div>

        <nav className="flex-1 overflow-y-auto overflow-x-hidden py-3">
          <ul className="space-y-1">
            {main.map(p => renderItem(p.key, p.label, p.base, p.icon))}
          </ul>
        </nav>
       
        <div className="border-t hairline py-3">
          <ul className="space-y-1">
            {bottom.map(p => renderItem(p.key, p.label, p.base, p.icon))}
          </ul>
          <ModeControl expanded={expanded} />
        </div>
         <VersionFooter expanded={expanded} />
      </aside>
    </div>
  );
}

// Running Motherbase version + a one-tap update recommendation when a newer
// release is published. Reads the same platform.version endpoint as the
// self-update panel; the "Update" link points at Org Settings where the update
// is applied.
function VersionFooter({ expanded }: { expanded: boolean }) {
  const { data } = useQuery({
    queryKey: ['platform-version'],
    queryFn: platform.version,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  if (!data) return null;
  const update = data.updateAvailable;

  if (!expanded) {
    // Rail is kept clean: only surface the accent update affordance, no version text.
    if (!update) return null;
    return (
      <NavLink
        href="/settings"
        title={`Update available: v${data.latest}`}
        className="nav-item mx-1.5 mb-1 mt-1 flex h-9 items-center justify-center rounded-md"
        style={{ color: 'var(--accent)' }}
      >
        <ArrowUpCircle size={18} />
      </NavLink>
    );
  }

  return (
    <div className="mx-1.5 mb-1 mt-1 flex items-center gap-2 px-2.5 py-1.5 text-[11px]" style={{ color: 'var(--text-mute)' }}>
      <span className="mono truncate">v{data.current}</span>
      {update && (
        <NavLink
          href="/settings"
          title={`Update to v${data.latest}`}
          className="ml-auto inline-flex shrink-0 items-center gap-1"
          style={{ color: 'var(--accent)', fontWeight: 600 }}
        >
          <ArrowUpCircle size={13} /> Update
        </NavLink>
      )}
    </div>
  );
}

const MODES: { value: SidebarMode; label: string; icon: typeof PanelLeft }[] = [
  { value: 'expanded', label: 'Expanded', icon: PanelLeftOpen },
  { value: 'collapsed', label: 'Collapsed', icon: PanelLeftClose },
  { value: 'hover', label: 'Expand on hover', icon: PanelLeft },
];

function ModeControl({ expanded }: { expanded: boolean }) {
  const { mode, setMode } = useSidebar();
  const [open, setOpen] = useState(false);
  const current = MODES.find(m => m.value === mode) ?? MODES[2];
  const Icon = current.icon;

  return (
    <div className="relative mx-1.5 mt-1">
      <button
        onClick={() => setOpen(o => !o)}
        title="Sidebar control"
        aria-expanded={open}
        className="nav-item flex h-9 w-full items-center gap-2.5 rounded-md px-2.5"
        style={{ color: 'var(--text-dim)' }}
      >
        <Icon size={18} />
        {expanded && <span className="truncate text-[13px]">{current.label}</span>}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute bottom-full left-0 z-50 mb-1 w-[190px] rounded-md border py-1 shadow-lg"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
          >
            {MODES.map(({ value, label, icon: MIcon }) => (
              <button
                key={value}
                onClick={() => { setMode(value); setOpen(false); }}
                className="nav-item flex w-full items-center gap-2.5 px-3 py-2 text-[13px]"
                style={{ color: value === mode ? 'var(--text)' : 'var(--text-dim)' }}
              >
                <MIcon size={15} />
                <span className="flex-1 text-left">{label}</span>
                {value === mode && <Check size={14} color="var(--accent)" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
