'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { EmptyState } from '@/shared/ui/EmptyState';
import { QueryState } from '@/shared/ui/QueryState';
import { rlsApi } from '@/features/database/lib/rls-api';
import { AccessLegend, AccessMatrix } from '@/features/database/components/rls/AccessMatrix';
import { AccessDetail } from '@/features/database/components/rls/AccessDetail';

/**
 * Who can read and write what through the data API, for every table at once.
 *
 * Read from grants and policies on the server, so there is nothing to type and
 * no caller to pick: the question is only ever "signed out or signed in, and
 * which command", and the answer is a grid.
 */
export default function RoleAccess() {
  const accessQ = useQuery({ queryKey: ['rls-access'], queryFn: rlsApi.accessMatrix });
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <PageShell width="wide">
      <PageHeader
        title="Role access"
        subtitle="What a signed-out visitor (anon) and a signed-in user (authenticated) can do to each table through the API. Click a table to see which grant or policy decides."
      />

      <QueryState
        query={accessQ}
        errorTitle="Could not load table access"
        empty={<EmptyState title="No tables yet" description="Create a table and its access shows up here." />}
      >
        {tables => {
          const detail = tables.find(t => t.table === selected);
          return (
            <div className="space-y-4">
              <AccessLegend />
              <AccessMatrix
                tables={tables}
                selected={selected}
                onSelect={table => setSelected(prev => (prev === table ? null : table))}
              />
              {detail && <AccessDetail table={detail} />}
            </div>
          );
        }}
      </QueryState>
    </PageShell>
  );
}
