// The app is always served by the Platform Console (apps/server/console/server.ts),
// which reaches each project through its admin proxy. See docs/glossary.md.

/**
 * The mount the Console serves the app under, mirroring `basePath` in
 * next.config.mjs. Next prefixes routes and its own assets automatically;
 * anything addressed by hand (a public/ file, a location assignment) has to
 * carry it.
 */
export const BASE_PATH = '/studio';

let currentProjectId: string | null = null;

const currentPathname = () => (typeof window === 'undefined' ? '/' : window.location.pathname);

/**
 * The project id from a project route. The basePath is stripped before the app
 * sees the pathname, so project routes read as /p/<id>/... with no prefix.
 */
export function projectIdFromPathname(pathname = currentPathname()): string | null {
  const match = pathname.match(/^\/p\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export const project = {
  get: () => currentProjectId ?? projectIdFromPathname(),
  set: (id: string | null) => {
    currentProjectId = id;
  },
};

/**
 * An absolute route inside a project, e.g. projectPath('/sql'). Falls back to
 * the projects list when no project is in scope.
 */
export function projectPath(sub: string, id = project.get()): string {
  return id ? `/p/${encodeURIComponent(id)}${sub}` : '/';
}
