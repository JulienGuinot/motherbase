import { useEffect, useMemo, useRef, useState } from 'react';
import { projectPath } from '@/shared/lib/project';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Moon, Sun, LogOut, Search } from 'lucide-react';
import { usePreferences } from '@/shared/lib/theme';
import { useSignOut } from '@/shared/hooks/useSignOut';
import { flatNav } from '@/shared/lib/nav';

interface Item {
  id: string;
  label: string;
  hint?: string;
  /** Search-only synonyms; never rendered. */
  keywords?: string[];
  group: string;
  icon: React.ComponentType<{ size?: number }>;
  run: () => void;
}

export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  return open ? <CommandPaletteContent onClose={onClose} /> : null;
}

function CommandPaletteContent({ onClose }: { onClose: () => void }) {
  const navigate = useRouter();
  const signOut = useSignOut();
  const { resolvedTheme, toggle } = usePreferences();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timeout);
  }, []);

  const items: Item[] = useMemo(() => [
    ...flatNav().map(entry => ({
      id: entry.id,
      label: entry.label,
      keywords: entry.keywords,
      group: 'Navigate',
      icon: entry.icon,
      run: () => navigate.push(projectPath(entry.path)),
    })),
    { id: 'theme', label: resolvedTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', group: 'Preferences', icon: resolvedTheme === 'dark' ? Sun : Moon, run: toggle },
    { id: 'logout', label: 'Sign out', group: 'Account', icon: LogOut, run: signOut },
  ], [navigate, resolvedTheme, signOut, toggle]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return items;
    return items.filter(
      it =>
        it.label.toLowerCase().includes(term) ||
        it.group.toLowerCase().includes(term) ||
        it.keywords?.some(keyword => keyword.includes(term)),
    );
  }, [items, q]);


  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, filtered.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
    if (e.key === 'Enter') { e.preventDefault(); filtered[idx]?.run(); onClose(); }
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }


  const groups: Record<string, Item[]> = {};
  filtered.forEach(it => { (groups[it.group] ||= []).push(it); });

  let runningIdx = -1;
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-start justify-center pt-32" onClick={onClose}>
      <div className="modal-scrim absolute inset-0" />
      <div
        className="card relative w-[min(640px,90vw)] rise"
        style={{ background: 'var(--surface)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b hairline px-4 py-3 pt-5">
          <Search size={14} style={{ color: 'var(--text-mute)' }} />
          <input
            ref={inputRef}
            value={q}
            onChange={e => { setQ(e.target.value); setIdx(0); }}
            onKeyDown={onKey}
            placeholder="Type a command, page, or action…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:opacity-50"
          />
          <kbd>ESC</kbd>
        </div>
        <div className="max-h-[420px] overflow-auto py-2">
          {Object.entries(groups).map(([group, list]) => (
            <div key={group} className="mb-1">
              <div className="px-4 pb-1 pt-2 label">{group}</div>
              {list.map(it => {
                runningIdx++;
                const active = runningIdx === idx;
                const Icon = it.icon;
                return (
                  <button
                    key={it.id}
                    onMouseEnter={() => setIdx(runningIdx)}
                    onClick={() => { it.run(); onClose(); }}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left text-[13px]"
                    style={{ background: active ? 'var(--accent-soft)' : 'transparent' }}
                  >
                    <Icon size={14} />
                    <span className="flex-1">{it.label}</span>
                    {active && <kbd>↵</kbd>}
                  </button>
                );
              })}
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center text-sm" style={{ color: 'var(--text-mute)' }}>
              No results for "{q}"
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
