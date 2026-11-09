'use client';

import Link from 'next/link';
import { useProjectId } from '@/shared/hooks/useRouteParam';
import { Badge } from '@/shared/ui/Badge';
import { Section } from '@/shared/ui/Section';
import type { TableAccess } from '@/features/database/lib/rls-api';
import {
  ACCESS_COMMANDS,
  ACCESS_ROLES,
  COMMAND_LABEL,
  ROLE_LABEL,
  describeAccess,
} from '@/features/database/lib/rls-access';

/** The "why" behind one row of the matrix: each cell spelled out, with the policies it depends on. */
export function AccessDetail({ table }: { table: TableAccess }) {
  const projectId = useProjectId();

  return (
    <Section
      title={table.table}
      description={table.rlsEnabled ? 'RLS is on.' : 'RLS is off: the grants alone decide.'}
      actions={
        <Link href={`/p/${projectId}/auth/policies?table=${encodeURIComponent(table.table)}`} className="btn">
          Edit policies
        </Link>
      }
    >
      <div className="grid gap-5 md:grid-cols-2">
        {ACCESS_ROLES.map(role => (
          <div key={role} className="min-w-0">
            <h3 className="mb-2 text-[12px]" style={{ color: 'var(--text-mute)', fontWeight: 500 }}>
              {ROLE_LABEL[role]}
            </h3>
            <ul className="space-y-3">
              {ACCESS_COMMANDS.map(command => {
                const access = table.access[role][command];
                const { tone, label, reason } = describeAccess(access, role, command, table.rlsEnabled);
                return (
                  <li key={command} className="text-[13px]">
                    <div className="flex items-center gap-2">
                      <span className="w-14 shrink-0" style={{ fontWeight: 500 }}>
                        {COMMAND_LABEL[command]}
                      </span>
                      <Badge tone={tone} dot>
                        {label}
                      </Badge>
                    </div>
                    <p className="mt-1 text-[12px]" style={{ color: 'var(--text-dim)' }}>
                      {reason}
                    </p>
                    {access.level === 'some' && (
                      <ul className="mt-1 space-y-1">
                        {access.conditions.map(c => (
                          <li key={`${c.command}-${c.policy}`} className="min-w-0 text-[12px]">
                            <span style={{ fontWeight: 500 }}>{c.policy}</span>
                            <span style={{ color: 'var(--text-mute)' }}>
                              {' '}
                              {c.command}
                              {c.restrictive ? ', restrictive' : ''}
                            </span>
                            <div className="mono break-words" style={{ color: 'var(--text-dim)' }}>
                              {[c.using && `USING ${c.using}`, c.withCheck && `CHECK ${c.withCheck}`]
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}
