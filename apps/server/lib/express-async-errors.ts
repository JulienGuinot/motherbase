/**
 * Express 4 calls a handler and drops whatever it returns. A rejected promise
 * from an async route or middleware therefore never reaches `next(err)`: the
 * request hangs with no response until the client gives up, and the error only
 * surfaces as an `unhandledRejection`. That is how `/api/auth/get-session` hung
 * on a production project (AGENTS.md rule 12).
 *
 * Express 5 forwards those rejections itself. This gives Express 4 the same
 * behaviour at the one place every route, middleware and error handler is
 * invoked, so no call site has to remember a try/catch or a `.catch(next)`.
 * Import it for its side effect before any app is built.
 *
 * ponytail: replaces two methods of express/lib/router/layer, an Express 4
 * internal (frozen on the 4.x line). Delete this file when moving to Express 5.
 */
const Layer = require('express/lib/router/layer');

type Next = (err?: unknown) => void;
type LayerThis = { handle: (...args: unknown[]) => unknown };

/**
 * Native promises only, which is what an async function returns. A Prisma query
 * is a lazy thenable: calling `.then` on one a handler returned without awaiting
 * would run a query that today never runs.
 */
function forwardRejection(result: unknown, next: Next): void {
  if (result instanceof Promise) {
    // Express 5's rule: a rejection with no reason still has to be an error.
    result.catch((err: unknown) => next(err ?? new Error('Rejected promise')));
  }
}

Layer.prototype.handle_request = function handleRequest(this: LayerThis, req: unknown, res: unknown, next: Next) {
  const fn = this.handle;
  if (fn.length > 3) return next();
  try {
    forwardRejection(fn(req, res, next), next);
  } catch (err) {
    next(err);
  }
};

Layer.prototype.handle_error = function handleError(this: LayerThis, error: unknown, req: unknown, res: unknown, next: Next) {
  const fn = this.handle;
  if (fn.length !== 4) return next(error);
  try {
    forwardRejection(fn(error, req, res, next), next);
  } catch (err) {
    next(err);
  }
};
