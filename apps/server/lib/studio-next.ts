import fs from 'fs';
import path from 'path';
import type { Express, NextFunction, Request, Response } from 'express';

/** Canonical mount for the studio bundle, matching next.config.mjs basePath. */
export const STUDIO_MOUNT = '/studio';

/**
 * Locate the built studio (the `studio` workspace, whose next build lands in
 * apps/studio/.next). Candidates cover running from the repo root or from the
 * server workspace, compiled (runtimeDir = apps/server/dist or
 * apps/server/dist/console) or via ts-node.
 */
export function findStudioDir(
  cwd = process.cwd(),
  runtimeDir = __dirname,
  exists: (p: string) => boolean = fs.existsSync
): string | undefined {
  return [
    path.join(cwd, 'apps', 'studio'),
    path.join(cwd, '..', 'studio'),
    path.join(runtimeDir, '..', '..', 'studio'),
    path.join(runtimeDir, '..', '..', '..', 'studio'),
  ].find(dir => exists(path.join(dir, '.next', 'BUILD_ID')));
}

/** True for the studio mount itself and anything under it, but not /studios. */
export function isStudioPath(pathname: string): boolean {
  return pathname === STUDIO_MOUNT || pathname.startsWith(`${STUDIO_MOUNT}/`);
}

/**
 * Mount the studio's next request handler. The handler has to receive the URL
 * with its /studio prefix intact (that is the configured basePath), so this is
 * a path-testing middleware rather than app.use('/studio', ...), which would
 * strip the prefix. `next` is resolved from the studio workspace, so the server
 * does not have to carry it as a dependency of its own.
 */
export async function mountStudio(app: Express, dir: string): Promise<void> {
  const createNextApp = require(require.resolve('next', { paths: [dir] }));
  const nextApp = createNextApp({ dev: false, dir });
  await nextApp.prepare();
  const handle = nextApp.getRequestHandler();

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isStudioPath(req.path)) return next();
    return handle(req, res);
  });
}
