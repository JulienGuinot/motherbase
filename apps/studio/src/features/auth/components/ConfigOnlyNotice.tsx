'use client';

import Link from 'next/link';
import { Table2 } from 'lucide-react';
import { projectPath } from '@/shared/lib/project';

/**
 * Says plainly that a page configures a feature rather than listing what it
 * registered, and points at where the records actually are.
 *
 * Passkeys and Organizations are settings forms. Their titles read like
 * inventories, so an operator looking for "which passkeys are enrolled" or
 * "which organizations exist" finds a form with no answer and no hint that the
 * rows are one page away in the table editor.
 */
export function ConfigOnlyNotice({
  subject,
  tables,
}: {
  /** What this page configures, e.g. "passkey sign-in". */
  subject: string;
  /** Records backing it: `auth` schema table names, as the editor addresses them. */
  tables: string[];
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border px-3 py-2.5 text-[12px]"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--surface-2)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--text-dim)',
      }}
    >
      <Table2 size={14} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
      <span>
        This page configures {subject}. It is not a list of what is registered: those rows live in the{' '}
        <strong>auth</strong> schema.
      </span>
      {tables.map(table => (
        <Link
          key={table}
          href={projectPath(`/tables/${encodeURIComponent(`auth.${table}`)}`)}
          className="mono"
          style={{ color: 'var(--accent)' }}
        >
          auth.{table}
        </Link>
      ))}
    </div>
  );
}
