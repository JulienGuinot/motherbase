import type { PageContext } from '@/features/assistant/api/assistant.api';

export interface ContextExtras {
  project?: string;
  schema?: string;
  table?: string;
  selection?: string;
}

/** Turns the router path into the project id plus a project-relative route. */
export function pageContextFrom(pathname: string, extras: ContextExtras): PageContext {
  const parts = pathname.split('/').filter(Boolean);
  const scoped = parts[0] === 'p' && parts[1];
  return {
    project: scoped ? parts[1] : (extras.project ?? 'default'),
    route: '/' + (scoped ? parts.slice(2) : parts).join('/'),
    schema: extras.schema,
    table: extras.table,
    selection: extras.selection,
  };
}
