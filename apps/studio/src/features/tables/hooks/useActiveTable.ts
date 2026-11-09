'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSchema } from '@/shared/lib/schema';
import { projectPath } from '@/shared/lib/project';
import { useRouteParam } from '@/shared/hooks/useRouteParam';
import { useTables } from '@/features/tables/hooks/useTables';
import { SYSTEM_SCHEMAS } from '@/features/tables/lib/table-editor';

/**
 * The table on screen, always one that belongs to the selected schema, so
 * the grid, the sidebar, the structure panels and the read-only decision all
 * describe the same table after a schema switch.
 */
export function useActiveTable() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const model = useRouteParam('model');
  const { schema } = useSchema();
  const [tableSearch, setTableSearch] = useState('');
  const tablesQuery = useTables();

  const inSchema = useMemo(
    () => (tablesQuery.data ?? []).filter(table => table.schema === schema),
    [tablesQuery.data, schema],
  );
  const requested = model ? tablesQuery.data?.find(t => t.model === model) : undefined;
  const meta = requested && requested.schema === schema ? requested : inSchema[0];
  const active = meta?.model;

  // Keep the URL honest about what is on screen. Without this the address bar
  // still names a table from the schema the operator just left, and a reload or
  // a shared link reopens the mismatch.
  useEffect(() => {
    if (!tablesQuery.data || !active || model === active) return;
    // Built from the project route helper, not by trimming the pathname: on
    // /tables (no model segment yet) trimming would drop "tables" instead.
    const query = searchParams.toString();
    router.replace(projectPath(`/tables/${encodeURIComponent(active)}`) + (query ? `?${query}` : ''));
    // `pathname`/`searchParams` are stable per navigation; re-running on the
    // table identity is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, model, tablesQuery.data]);

  const tables = useMemo(() => {
    const term = tableSearch.trim().toLowerCase();
    if (!term) return inSchema;
    return inSchema.filter(t => t.model.toLowerCase().includes(term) || t.dbName.toLowerCase().includes(term));
  }, [inSchema, tableSearch]);

  /** dbName to model segment, to turn a foreign key into an editor link. */
  const modelByTable = useMemo(() => {
    const map: Record<string, string> = {};
    for (const table of tablesQuery.data ?? []) map[table.dbName] = table.model;
    return map;
  }, [tablesQuery.data]);

  return {
    schema,
    meta,
    active,
    readOnly: SYSTEM_SCHEMAS.has(meta?.schema ?? schema),
    tables,
    tablesLoading: tablesQuery.isLoading,
    tableSearch,
    setTableSearch,
    modelByTable,
  };
}
