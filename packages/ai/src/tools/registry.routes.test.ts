import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from './registry';

/**
 * Guards against a typo'd tool path silently going nowhere. Reads the real
 * `@route(...)` decorators out of the admin controllers (each mounted at
 * `/api/admin`, each method contributing its own sub-path plus an HTTP
 * method decorator such as `@GET()`/`@POST()`) and checks that every tool in
 * the registry points at a route that actually exists, with the method the
 * tool declares.
 */

const CONTROLLER_FILES = [
  'admin-schema.controller.ts',
  'admin-security.controller.ts',
  'admin-observability.controller.ts',
  'admin-core.controller.ts',
  'admin-database.controller.ts',
  'admin-queues.controller.ts',
];

const CONTROLLERS_DIR = join(__dirname, '../../../../apps/server/controllers/admin');

interface Route {
  method: string;
  path: string;
}

function parseRoutes(): Route[] {
  const routes: Route[] = [];
  for (const file of CONTROLLER_FILES) {
    const source = readFileSync(join(CONTROLLERS_DIR, file), 'utf8');
    // Match an HTTP method decorator immediately followed (allowing for the
    // class-level @route above it) by a @route('/path') decorator on the
    // next line, which is the shape every handler in these controllers uses.
    const methodDecoratorRe = /@(GET|POST|PUT|PATCH|DELETE)\(\)\s*\r?\n\s*@route\('([^']+)'\)/g;
    let match: RegExpExecArray | null;
    while ((match = methodDecoratorRe.exec(source))) {
      routes.push({ method: match[1], path: match[2] });
    }
  }
  return routes;
}

/** Turns `/schema/tables/:table` into a matcher for `/schema/tables/{table}`. */
function routeMatchesToolPath(routePath: string, toolPath: string): boolean {
  const routeSegments = routePath.split('/');
  const toolSegments = toolPath.split('/');
  if (routeSegments.length !== toolSegments.length) return false;
  return routeSegments.every((seg, i) => {
    const toolSeg = toolSegments[i];
    if (seg.startsWith(':')) return toolSeg.startsWith('{') && toolSeg.endsWith('}');
    return seg === toolSeg;
  });
}

describe('tool registry routes exist on the server', () => {
  const routes = parseRoutes();

  it('parsed at least one route per controller (sanity check on the regex)', () => {
    expect(routes.length).toBeGreaterThan(20);
  });

  for (const tool of ALL_TOOLS) {
    it(`${tool.name} -> ${tool.http.method} ${tool.http.path} exists on the server`, () => {
      const found = routes.some(
        r => r.method === tool.http.method && routeMatchesToolPath(r.path, tool.http.path),
      );
      if (!found) {
        const sameMethod = routes.filter(r => r.method === tool.http.method).map(r => r.path);
        const closest = routes.find(r => routeMatchesToolPath(r.path, tool.http.path));
        throw new Error(
          `No ${tool.http.method} route matches tool "${tool.name}" path "${tool.http.path}". ` +
            (closest
              ? `Closest path match uses method ${closest.method} instead of ${tool.http.method}.`
              : `Routes with method ${tool.http.method}: ${sameMethod.join(', ') || '(none)'}`),
        );
      }
      expect(found).toBe(true);
    });
  }
});
