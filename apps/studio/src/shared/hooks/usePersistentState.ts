'use client';

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useProjectId } from '@/shared/hooks/useRouteParam';

function read<T>(key: string, initial: T | (() => T)): T {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    if (raw !== null) return JSON.parse(raw) as T;
  } catch {
    /* fall through to the initial value */
  }
  return typeof initial === 'function' ? (initial as () => T)() : initial;
}

/**
 * State mirrored into localStorage. A corrupt or absent entry falls back to the
 * initial value rather than throwing, because a bad key must never stop a page
 * from rendering.
 *
 * When `key` changes the entry for the new key is re-read: without that, moving
 * between two projects kept the first one's state on screen and then wrote it
 * over the second one's entry.
 */
export function usePersistentState<T>(key: string, initial: T | (() => T)) {
  const [state, setState] = useState(() => ({ key, value: read(key, initial) }));
  const value = state.key === key ? state.value : read(key, initial);

  if (state.key !== key) setState({ key, value });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full or blocked; the app keeps working in memory */
    }
  }, [key, value]);

  const setValue = useCallback<Dispatch<SetStateAction<T>>>(next => {
    setState(current => ({
      key: current.key,
      value: typeof next === 'function' ? (next as (prev: T) => T)(current.value) : next,
    }));
  }, []);

  return [value, setValue] as const;
}

/**
 * Same, but the entry belongs to the project in the URL. Anything that
 * describes a project's data (open SQL tabs, the selected schema, hidden
 * columns) must not survive a switch to another project.
 */
export function useProjectPersistentState<T>(key: string, initial: T | (() => T)) {
  const id = useProjectId();
  return usePersistentState<T>(`p.${id ?? 'none'}.${key}`, initial);
}
