'use client';

import { Check, CircleDashed, Minus, type LucideIcon } from 'lucide-react';
import type { TableAccess } from '@/features/database/lib/rls-api';
import { ACCESS_COMMANDS, ACCESS_ROLES, COMMAND_LABEL, describeAccess } from '@/features/database/lib/rls-access';

type AccessTone = ReturnType<typeof describeAccess>['tone'];

// `table.console th` aligns left and outranks a utility class.
const CENTER = { textAlign: 'center' } as const;
// The table name stays put while the grid scrolls sideways on a phone.
const PINNED = { left: 0 } as const;

const MARK: Record<AccessTone, { Icon: LucideIcon; color: string; legend: string }> = {
  success: { Icon: Check, color: 'var(--green)', legend: 'Every row' },
  warn: { Icon: CircleDashed, color: 'var(--amber)', legend: 'Only rows a policy allows' },
  neutral: { Icon: Minus, color: 'var(--text-mute)', legend: 'Not allowed' },
};

/** One row per table, one column per role and command. Click a row for the why. */
export function AccessMatrix({
  tables,
  selected,
  onSelect,
}: {
  tables: TableAccess[];
  selected: string | null;
  onSelect: (table: string) => void;
}) {
  return (
    <div className="card overflow-auto">
      <table className="console">
        <thead>
          <tr>
            <th rowSpan={2} className="sticky-col sticky-col-last" style={PINNED}>
              Table
            </th>
            {ACCESS_ROLES.map(role => (
              <th key={role} colSpan={ACCESS_COMMANDS.length} style={CENTER}>
                {role}
              </th>
            ))}
          </tr>
          <tr>
            {ACCESS_ROLES.flatMap(role =>
              ACCESS_COMMANDS.map(command => (
                <th key={`${role}-${command}`} style={CENTER}>
                  {COMMAND_LABEL[command]}
                </th>
              ))
            )}
          </tr>
        </thead>
        <tbody>
          {tables.map(t => (
            <tr
              key={t.table}
              onClick={() => onSelect(t.table)}
              data-checked={t.table === selected}
              className="cursor-pointer"
            >
              <td className="sticky-col sticky-col-last" style={PINNED}>
                <button type="button" className="font-medium" aria-pressed={t.table === selected}>
                  {t.table}
                </button>
              </td>
              {ACCESS_ROLES.flatMap(role =>
                ACCESS_COMMANDS.map(command => {
                  const { tone, label, reason } = describeAccess(t.access[role][command], role, command, t.rlsEnabled);
                  const { Icon, color } = MARK[tone];
                  return (
                    <td key={`${role}-${command}`} style={CENTER} title={reason}>
                      <Icon
                        size={15}
                        aria-label={`${role} ${COMMAND_LABEL[command]}: ${label}`}
                        style={{ color, display: 'inline' }}
                      />
                    </td>
                  );
                })
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What the three symbols mean, above the matrix. */
export function AccessLegend() {
  return (
    <div className="flex flex-wrap gap-4 text-[12px]" style={{ color: 'var(--text-dim)' }}>
      {Object.values(MARK).map(({ Icon, color, legend }) => (
        <span key={legend} className="inline-flex items-center gap-1.5">
          <Icon size={14} style={{ color }} />
          {legend}
        </span>
      ))}
    </div>
  );
}
