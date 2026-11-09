'use client';

import { useState } from 'react';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import SchemaSelect from '@/shared/ui/SchemaSelect';
import Select from '@/shared/ui/Select';
import { QueryState } from '@/shared/ui/QueryState';
import { EmptyState } from '@/shared/ui/EmptyState';
import { Note } from '@/shared/ui/Row';
import { useProjectCapability } from '@/features/platform/hooks/usePlatformAccess';
import { useSchema } from '@/shared/lib/schema';
import { useSchemaTables } from '@/features/sql/hooks/useSchemaTables';
import { catalogApi, COLUMN_PRIVILEGES, type ColumnPrivilege, type ColumnPrivilegeChange } from '@/features/database/api/catalog.api';
import { useCatalogWrite, useColumnPrivileges } from '@/features/database/hooks/useCatalog';

/** What each checkbox column lets the role do, in REST terms. */
const PRIVILEGE_MEANING: Record<ColumnPrivilege, string> = {
  SELECT: 'Read the column: select it, filter or order by it.',
  INSERT: 'Give the column a value when creating a row. Unchecked, inserts must leave it to its default.',
  UPDATE: 'Change the column on an existing row.',
  REFERENCES: 'Point a foreign key of another table at the column.',
};

/** Who each API role is, so the role picker means something. */
const ROLE_MEANING: Record<string, string> = {
  anon: 'Requests with no signed-in user: the publishable key alone.',
  authenticated: 'Requests from a signed-in user.',
  service_role: 'Server-side requests with the secret key. It skips RLS, but not these grants.',
};

/**
 * Database > Column Privileges: which columns a role may read or write,
 * enforced by Postgres itself underneath RLS. The usual use is hiding a
 * column (a cost price, an internal note) from `anon` or `authenticated`
 * while the rest of the row stays readable through the REST API.
 */
export default function ColumnPrivileges() {
  const { schema } = useSchema();
  const tablesQuery = useSchemaTables(schema);
  const [pickedTable, setTable] = useState('');
  const [pickedRole, setRole] = useState('');
  // Same rule as WriteButton: stay enabled while the session loads.
  const access = useProjectCapability('content.write');
  const readOnly = !access.pending && !access.editable;

  const tables = tablesQuery.data ?? [];
  // Fall back to the first table of the schema on screen, so a schema switch
  // never leaves a table from the previous one selected.
  const table = tables.some(t => t.name === pickedTable) ? pickedTable : tables[0]?.name;
  const matrixQuery = useColumnPrivileges(schema, table);
  const roles = matrixQuery.data?.roles ?? [];
  const role = roles.some(r => r.role === pickedRole) ? pickedRole : roles[0]?.role;
  const entry = roles.find(r => r.role === role);

  const change = useCatalogWrite({
    run: (body: ColumnPrivilegeChange) => catalogApi.setColumnPrivilege(body),
    invalidate: 'schema.changed',
    success: body => `${body.grant ? 'Granted' : 'Revoked'} ${body.privilege} on ${body.columns.length === 1 ? body.columns[0] : `${body.columns.length} columns`}`,
    failTitle: 'Privilege change failed',
  });

  const set = (privilege: ColumnPrivilege, columns: string[], grant: boolean) => {
    if (!table || !role) return;
    change.mutate({ schema, table, role, privilege, columns, grant });
  };

  const tableLevel = entry ? COLUMN_PRIVILEGES.filter(privilege => entry.privileges[privilege].tableLevel) : [];
  const unreadable = entry && matrixQuery.data ? matrixQuery.data.columns.filter(c => !entry.privileges.SELECT.columns.includes(c)) : [];

  return (
    <PageShell width="wide">
      <PageHeader
        title="Column Privileges"
        subtitle="Hide a column from a role, or make it read-only, while the rest of the row stays reachable."
        actions={
          <>
            <SchemaSelect />
            <Select value={table ?? ''} onChange={setTable} label="table" ariaLabel="Table" disabled={!tables.length} options={tables.map(t => ({ value: t.name, label: t.name }))} />
            <Select value={role ?? ''} onChange={setRole} label="role" ariaLabel="Role" disabled={!roles.length} options={roles.map(r => ({ value: r.role, label: r.role }))} />
          </>
        }
      />

      <Note>
        RLS policies decide which <em>rows</em> a role reaches; this page decides which <em>columns</em> of those rows. Pick a
        table and a role, then uncheck what that role must not touch: unchecking <span className="mono">SELECT</span> on{' '}
        <span className="mono">cost_price</span> for <span className="mono">anon</span> hides that column from logged-out
        visitors. Postgres enforces it: a request that names a column it may not read is refused with a permission error, so
        clients must select the columns they need rather than <span className="mono">*</span>.
      </Note>

      {role && (
        <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
          <span className="mono" style={{ color: 'var(--text)' }}>{role}</span>: {ROLE_MEANING[role] ?? 'A database role. Requests reach it only through a role it is granted to, or a direct login.'}
          {unreadable.length > 0 && <> Cannot read: <span className="mono">{unreadable.join(', ')}</span>.</>}
        </p>
      )}

      {tableLevel.length > 0 && (
        <Note>
          <span className="mono">{role}</span> holds {tableLevel.join(', ')} on the whole table. Unchecking a column replaces
          that grant with one on every other column, which is the only way Postgres can hide a single column.
        </Note>
      )}

      {!tablesQuery.isLoading && !tables.length ? (
        <div className="card"><EmptyState size="md" mascot="plug-cable" title={`No tables in ${schema}`} /></div>
      ) : (
        <QueryState query={matrixQuery} skeletonRows={6} isEmpty={matrix => matrix.columns.length === 0}>
          {matrix => entry && (
            <div className="card overflow-x-auto p-0">
              <table className="console">
                <thead>
                  <tr>
                    <th>Column</th>
                    {COLUMN_PRIVILEGES.map(privilege => {
                      const granted = entry.privileges[privilege].columns;
                      const all = granted.length === matrix.columns.length;
                      return (
                        <th key={privilege} className="text-center">
                          <label className="inline-flex cursor-pointer items-center gap-2" title={PRIVILEGE_MEANING[privilege]}>
                            <input
                              type="checkbox"
                              checked={all}
                              ref={input => { if (input) input.indeterminate = !all && granted.length > 0; }}
                              disabled={readOnly || change.isPending}
                              onChange={() => set(privilege, all ? matrix.columns : matrix.columns.filter(c => !granted.includes(c)), !all)}
                              aria-label={`${privilege} on every column`}
                            />
                            {privilege}
                          </label>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {matrix.columns.map(column => (
                    <tr key={column}>
                      <td className="mono text-[12px]">{column}</td>
                      {COLUMN_PRIVILEGES.map(privilege => {
                        const granted = entry.privileges[privilege].columns.includes(column);
                        return (
                          <td key={privilege} className="text-center">
                            <input
                              type="checkbox"
                              checked={granted}
                              disabled={readOnly || change.isPending}
                              onChange={() => set(privilege, [column], !granted)}
                              aria-label={`${privilege} on ${column}`}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <dl className="grid gap-x-6 gap-y-1.5 border-t hairline px-4 py-3 text-[11.5px] sm:grid-cols-2" style={{ color: 'var(--text-mute)' }}>
                {COLUMN_PRIVILEGES.map(privilege => (
                  <div key={privilege}>
                    <dt className="mono inline" style={{ color: 'var(--text-dim)' }}>{privilege}</dt>{' '}
                    <dd className="inline">{PRIVILEGE_MEANING[privilege]}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </QueryState>
      )}
    </PageShell>
  );
}
