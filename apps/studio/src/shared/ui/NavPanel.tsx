
import { NavLink } from '@/shared/ui/NavLink';
import { SubNavBar, SubNavPill } from '@/shared/ui/SubNav';
import { useProjectId } from '@/shared/hooks/useRouteParam';
import type { NavPanelConfig } from '@/shared/lib/nav';

// Generic contextual panel (Supabase-style secondary nav). Config-driven.
// Replaces the former per-section AuthLayout. Rendered by ProductLayout beside
// the icon rail for products that declare a static panel.
export default function NavPanel({ base, config }: { base: string; config: NavPanelConfig }) {
  const id = useProjectId();
  const projectBase = id ? `/p/${id}${base}` : base;
  const links = config.items.map(({ to, label, icon: Icon }) => (
    <NavLink key={to || 'index'} href={to ? `${projectBase}/${to}` : projectBase} end={to === ''} className="shrink-0">
      {({ isActive }) => <SubNavPill label={label} icon={Icon} active={isActive} />}
    </NavLink>
  ));

  return (
    <>
      <SubNavBar label={`${config.title} sections`} className="md:hidden">
        {links}
      </SubNavBar>
      <aside
      // `self-start` stops the flex row from stretching the panel to full content
      // height; without it `sticky top-0` has no travel room and the panel scrolls
      // away with the page. `overflow-y-auto` handles panels taller than the viewport.
      className="sticky top-0 hidden h-[calc(100vh-56px)] w-[224px] shrink-0 flex-col self-start overflow-y-auto border-r px-3 py-5 md:flex"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      <div className="label mb-3 px-2.5">{config.title}</div>
      <nav className="space-y-0.5">
        {links}
      </nav>
      </aside>
    </>
  );
}
