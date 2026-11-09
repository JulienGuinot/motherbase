import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { HTTP_ROUTES } from '@motherbase/contracts';

/**
 * The controller HTTP surface, extracted from the `@route` / `@GET` decorators.
 *
 * This exists because the published route table was hand-maintained while
 * claiming to be generated, and had drifted: four controllers mount on a
 * `HTTP_ROUTES` constant rather than a string literal, and the table listed
 * their UNRESOLVED paths: `/:model` instead of `/rest/v1/:model`, `/` instead
 * of `/realtime/v1/api/broadcast`. Every path copied out of it 404'd.
 *
 * Resolving those constants is therefore the job, not a nicety, which is why
 * `HTTP_ROUTES` is imported and consulted rather than pattern-matched.
 *
 * Static parsing, deliberately: reading the router `awilix-express` builds would
 * be closer to ground truth, but it requires loading every controller module
 * (and with it the DI container and its transitive imports) through a matching
 * CJS/ESM pipeline. A parse has no runtime, no container and no database, so it
 * runs identically from a test, a script, or a sibling repository.
 */

export interface RouteEntry {
  method: string;
  path: string;
  handler: string;
  guards: string[];
  /** Controller file the route came from, repo-relative. */
  source: string;
}

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'ALL']);
const METHOD_ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'ALL'];

/**
 * `@route('/x')` → `/x`; `@route(HTTP_ROUTES.rest)` → `/rest/v1`;
 * ``@route(`${HTTP_ROUTES.files}/bucket`)`` → `/api/files/bucket`.
 *
 * The template form exists so a controller mounted under an existing base can
 * reuse the constant instead of re-typing the literal, which is exactly the
 * drift the contracts package is there to prevent. A span this cannot resolve
 * still yields `undefined`, so an unrecognised expression fails loudly rather
 * than emitting a path that looks resolved and is not.
 */
function routeArgument(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isTemplateExpression(expression)) {
    let path = expression.head.text;
    for (const span of expression.templateSpans) {
      const resolved = routeArgument(span.expression);
      if (resolved === undefined) return undefined;
      path += resolved + span.literal.text;
    }
    return path;
  }
  // The only non-literal form in this codebase. Anything else is left undefined so the caller can fail loudly rather
  // than emit a path that looks resolved and is not.
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'HTTP_ROUTES'
  ) {
    return (HTTP_ROUTES as Record<string, string>)[expression.name.text];
  }
  return undefined;
}

function decoratorsOf(node: ts.Node): ts.Decorator[] {
  return (ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []) as ts.Decorator[];
}

function calledName(decorator: ts.Decorator): string | undefined {
  const call = decorator.expression;
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return undefined;
  return call.expression.text;
}

function callArguments(decorator: ts.Decorator): ts.NodeArray<ts.Expression> | undefined {
  const call = decorator.expression;
  return ts.isCallExpression(call) ? call.arguments : undefined;
}

/** `@before(adminOnly)` / `@before([a, b])` → the guard names, in order. */
function guardsOf(decorator: ts.Decorator): string[] {
  const args = callArguments(decorator);
  const first = args?.[0];
  if (!first) return [];
  const items = ts.isArrayLiteralExpression(first) ? Array.from(first.elements) : [first];
  return items.map(item => item.getText());
}

function joinPath(base: string, sub: string | undefined): string {
  const tail = sub === undefined || sub === '/' ? '' : sub;
  const joined = `${base}${tail}`.replace(/\/{2,}/g, '/');
  // The bare mount keeps its trailing slash only when that is the whole path.
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

function parseController(file: string, repoRoot: string): RouteEntry[] {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const relative = path.relative(repoRoot, file).split(path.sep).join('/');
  const entries: RouteEntry[] = [];

  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement)) continue;

    const classRoute = decoratorsOf(statement).find(d => calledName(d) === 'route');
    if (!classRoute) continue;
    const base = routeArgument(callArguments(classRoute)?.[0]);
    if (base === undefined) {
      throw new Error(`${relative}: could not resolve the class @route(...) base path`);
    }

    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || !member.name) continue;
      const decorators = decoratorsOf(member);

      const methods = decorators
        .map(calledName)
        .filter((name): name is string => !!name && HTTP_METHODS.has(name));
      if (!methods.length) continue;

      const methodRoute = decorators.find(d => calledName(d) === 'route');
      const sub = methodRoute ? routeArgument(callArguments(methodRoute)?.[0]) : undefined;
      if (methodRoute && sub === undefined) {
        throw new Error(`${relative}: could not resolve @route(...) on ${member.name.getText()}`);
      }

      const before = decorators.find(d => calledName(d) === 'before');
      const guards = before ? guardsOf(before) : [];

      for (const method of methods) {
        entries.push({
          method,
          path: joinPath(base, sub),
          handler: member.name.getText(),
          guards,
          source: relative,
        });
      }
    }
  }

  return entries;
}

/**
 * Every route the controllers mount, sorted so the output is stable across runs:
 * a manifest that reorders itself is a manifest nobody can diff.
 */
export function readRouteManifest(
  controllersDir: string = path.join(__dirname, '..', 'controllers'),
  repoRoot: string = path.join(__dirname, '..', '..', '..'),
): RouteEntry[] {
  // Recursive: controllers are grouped in subfolders (`admin/`), and the loader
  // in app.ts globs `controllers/**` the same way.
  const files = fs
    .readdirSync(controllersDir, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('.controller.ts'))
    .map(name => path.join(controllersDir, name));

  return files
    .flatMap(file => parseController(file, repoRoot))
    .sort(
      (a, b) =>
        a.source.localeCompare(b.source) ||
        a.path.localeCompare(b.path) ||
        METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
    );
}
