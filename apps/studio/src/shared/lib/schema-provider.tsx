import { type ReactNode } from 'react';
import { SchemaCtx } from '@/shared/lib/schema';
import { useProjectPersistentState } from '@/shared/hooks/usePersistentState';

export function SchemaProvider({ children }: { children: ReactNode }) {
  const [schema, setSchema] = useProjectPersistentState<string>('console.schema', 'public');

  return <SchemaCtx.Provider value={{ schema, setSchema }}>{children}</SchemaCtx.Provider>;
}
