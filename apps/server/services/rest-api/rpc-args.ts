import { HttpException } from '../../exceptions/http-exception';
import { quoteIdent } from '../admin/schema-ddl';
import type { CatalogFunction } from './catalog';
import type { createParams } from './sql-compiler';

type Params = ReturnType<typeof createParams>;

/** Arguments a caller can supply: IN, INOUT and VARIADIC. OUT arguments are results. */
function inputArgs(fn: CatalogFunction) {
  return fn.args.filter(arg => arg.mode === 'i' || arg.mode === 'b' || arg.mode === 'v');
}

/**
 * Choose the overload a call names. PostgREST resolves by argument NAMES, not
 * by arity, so the match is: every supplied name is an input argument of the
 * candidate, and every input argument without a default was supplied.
 */
export function pickOverload(
  fnName: string,
  overloads: CatalogFunction[],
  supplied: string[],
  singleObject: boolean,
): CatalogFunction {
  const match = overloads.find(fn => {
    // A VARIADIC tail cannot be filled through named notation, so such an
    // overload is never selectable over REST.
    if (fn.variadic) return false;
    const inputs = inputArgs(fn);
    if (singleObject) return inputs.length === 1 && !inputs[0].hasDefault;
    const names = new Set(inputs.map(arg => arg.name));
    if (!supplied.every(name => names.has(name))) return false;
    return inputs.every(arg => arg.hasDefault || supplied.includes(arg.name));
  });

  if (!match) {
    throw new HttpException(
      `Could not find the function public.${fnName} with the given argument names in the schema cache.`,
      404,
      'PGRST202',
      { expose: true },
    );
  }
  return match;
}

/** `"a" := $1, "b" := $2`. Argument names come from the catalog, never the body. */
export function bindNamedArgs(fn: CatalogFunction, args: Record<string, unknown>, params: Params): string {
  return inputArgs(fn)
    .filter(arg => Object.prototype.hasOwnProperty.call(args ?? {}, arg.name))
    .map(arg => {
      const value = (args as Record<string, unknown>)[arg.name];
      // Named notation resolves the function signature first, so an untyped
      // parameter is coerced to the declared argument type by Postgres itself.
      // json/jsonb are the exception: the driver would send an object as a
      // record literal, so it is serialised here.
      const bound =
        value !== null && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value;
      const cast = arg.pgType === 'json' || arg.pgType === 'jsonb' ? `::${arg.pgType}` : '';
      return `${quoteIdent(arg.name)} := ${params.push(bound ?? null)}${cast}`;
    })
    .join(', ');
}

/** `Prefer: params=single-object`: the whole body becomes one json argument. */
export function bindSingleObjectArg(
  fn: CatalogFunction,
  args: Record<string, unknown>,
  params: Params,
): string {
  const arg = fn.args.find(candidate => candidate.mode === 'i' || candidate.mode === 'b');
  if (!arg || (arg.pgType !== 'json' && arg.pgType !== 'jsonb')) {
    throw new HttpException(
      `Prefer: params=single-object requires public.${fn.name} to take exactly one json or jsonb argument.`,
      400,
      'PGRST202',
      { expose: true },
    );
  }
  return `${quoteIdent(arg.name)} := ${params.push(JSON.stringify(args ?? {}))}::${arg.pgType}`;
}
