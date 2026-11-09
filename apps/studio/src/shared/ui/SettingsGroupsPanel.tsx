import { useEffect, useState, type ReactNode } from 'react';
import SettingsForm from '@/shared/ui/SettingsForm';
import { SubNavTabs } from '@/shared/ui/SubNav';

export interface SettingsPanelItem {
  /** Registry group key (also the tab id), or an arbitrary id when `render` is set. */
  key: string;
  label: string;
  /** Replaces the group's own description under the form title. */
  description?: ReactNode;
  /** Custom panel body. Overrides the default SettingsForm for this item. */
  render?: () => ReactNode;
}

/**
 * Left sub-nav + right panel for a set of settings groups. Shared by the
 * platform Settings page and the per-product settings surfaces (Auth, etc.) so
 * every settings area looks and behaves identically. Below `lg` the sub-nav is
 * a pinned bar that slides sideways, instead of a column stacked on the form.
 */
export default function SettingsGroupsPanel({
  items,
  initial,
}: {
  items: SettingsPanelItem[];
  initial?: string;
}) {
  const [tab, setTab] = useState(initial ?? items[0]?.key);

  // Deep link: /auth/settings#email.smtp opens that group directly, so a
  // "configure this" link elsewhere can land on the exact form. Read after
  // mount, not in the initial state, to keep server and client markup equal.
  useEffect(() => {
    const key = decodeURIComponent(window.location.hash.slice(1));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the hash is browser-only, so it cannot be read during render without a hydration mismatch
    if (key && items.some(i => i.key === key)) setTab(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = items.find(i => i.key === tab) ?? items[0];

  return (
    <div className="grid gap-6 lg:grid-cols-[200px_1fr]">
      <SubNavTabs
        label="Settings sections"
        items={items.map(({ key, label }) => ({ id: key, label }))}
        value={active?.key ?? ''}
        onChange={setTab}
        className="lg:hidden"
      />
      <nav className="hidden space-y-1 lg:block">
        {items.map(it => (
          <button
            key={it.key}
            onClick={() => setTab(it.key)}
            className="block w-full rounded-md text-left px-3 py-2 text-[13px]"
            style={{
              background: tab === it.key ? 'var(--accent-soft)' : 'transparent',
              color: tab === it.key ? 'var(--text)' : 'var(--text-mute)',
              cursor: 'pointer',
            }}
          >
            {it.label}
          </button>
        ))}
      </nav>

      <div className="space-y-6">
        {active?.render ? (
          active.render()
        ) : active ? (
          <SettingsForm group={active.key} description={active.description} />
        ) : null}
      </div>
    </div>
  );
}
