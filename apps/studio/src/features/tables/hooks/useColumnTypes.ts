import { useMemo } from 'react';
import { useEnumTypes } from '@/features/database/hooks/useCatalog';
import { columnTypeGroups } from '@/features/tables/lib/column-types';

/** Column type options for a table in `schema`, including its enumerated types. */
export function useColumnTypeGroups(schema: string) {
  const enums = useEnumTypes(schema);
  return useMemo(() => columnTypeGroups(schema, (enums.data ?? []).map(type => type.name)), [schema, enums.data]);
}
