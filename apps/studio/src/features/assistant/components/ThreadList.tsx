'use client';

import { useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { EmptyState } from '@/shared/ui/EmptyState';
import type { ThreadSummary } from '@/features/assistant/api/assistant.api';

export default function ThreadList({
  threads,
  activeId,
  onOpen,
  onRename,
  onDelete,
}: {
  threads: ThreadSummary[];
  activeId?: string;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);

  if (!threads.length) {
    return <EmptyState title="No conversations yet" description="Ask a question to start one." />;
  }

  function commit() {
    if (!editing) return;
    const title = editing.title.trim();
    // An empty title would leave an unclickable blank row in the list.
    if (title) onRename(editing.id, title);
    setEditing(null);
  }

  return (
    <ul className="flex flex-col">
      {threads.map(t => (
        <li key={t.id} className="group flex items-center gap-2 px-3 py-1.5">
          {editing?.id === t.id ? (
            <input
              autoFocus
              aria-label={`Rename ${t.title}`}
              value={editing.title}
              onChange={e => setEditing({ id: t.id, title: e.target.value })}
              onBlur={commit}
              onKeyDown={e => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') setEditing(null);
              }}
              className="input min-w-0 flex-1 text-[12px]"
            />
          ) : (
            <>
              <button
                type="button"
                onClick={() => onOpen(t.id)}
                className="min-w-0 flex-1 truncate text-left text-[12px]"
                style={{ color: t.id === activeId ? 'var(--text)' : 'var(--text-mute)' }}
              >
                {t.title}
              </button>
              <button
                type="button"
                aria-label={`Rename ${t.title}`}
                onClick={() => setEditing({ id: t.id, title: t.title })}
                className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
              >
                <Pencil size={12} style={{ color: 'var(--text-mute)' }} />
              </button>
              <button type="button" aria-label={`Delete ${t.title}`} onClick={() => onDelete(t.id)}>
                <Trash2 size={12} style={{ color: 'var(--text-mute)' }} />
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
