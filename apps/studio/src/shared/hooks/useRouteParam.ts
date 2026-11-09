'use client';

import { useParams } from 'next/navigation';

/**
 * One dynamic route segment as a string. Next types params as
 * `string | string[]` because a catch-all can hold several segments; every
 * route in this app uses single segments, so unwrapping once here keeps the
 * cast out of every caller.
 */
export function useRouteParam(name: string): string | undefined {
  const value = useParams()?.[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The project id from /p/[id]. Undefined outside a project route. */
export function useProjectId(): string | undefined {
  return useRouteParam('id');
}
