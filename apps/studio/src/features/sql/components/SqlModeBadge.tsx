'use client';

import Link from 'next/link';
import { Lock } from 'lucide-react';
import { useSettingsGroup } from '@/shared/hooks/useSettingsGroup';
import { projectPath } from '@/shared/lib/project';

/**
 * Says whether the editor may write before a query is refused for it, and
 * links to the one place that changes it (Database > Settings > SQL editor).
 * Nothing is shown while the setting loads or when writes are allowed: the
 * read-only state is the one that surprises.
 */
export function SqlModeBadge() {
  const { query } = useSettingsGroup('database.sqlEditor');
  if (query.data?.values.allowWrites !== false) return null;

  return (
    <Link
      href={projectPath('/database/settings')}
      className="chip whitespace-nowrap"
      style={{ color: 'var(--amber)' }}
      title="INSERT, UPDATE, DELETE and DDL are refused. Allow writes under Database › Settings."
    >
      <Lock size={10} /> Read-only
    </Link>
  );
}
