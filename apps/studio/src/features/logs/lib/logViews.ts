import { useCallback } from 'react';
import { useProjectPersistentState } from '@/shared/hooks/usePersistentState';
import type { LogRangeKey } from '@/shared/lib/range';

// A saved log filter combination. `levels`/`sources` are stored as arrays for
// JSON serialisation; the Logs page converts them to Sets.
export interface LogView {
  id: string;
  name: string;
  levels: string[];
  sources: string[];
  query: string;
  range: LogRangeKey;
}

const KEY = 'console.logViews';

export function useSavedViews() {
  const [views, setViews] = useProjectPersistentState<LogView[]>(KEY, []);

  const save = useCallback((view: Omit<LogView, 'id'>) => {
    const entry: LogView = { ...view, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
    setViews(prev => [...prev, entry]);
    return entry;
  }, [setViews]);

  const remove = useCallback((id: string) => {
    setViews(prev => prev.filter(v => v.id !== id));
  }, [setViews]);

  return { views, save, remove };
}
