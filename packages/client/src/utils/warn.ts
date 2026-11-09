import { isProduction } from '../cookies/index.js';

/**
 * One warning per ignored option, in development only.
 *
 * An option this SDK accepts and does not act on is the worst shape of
 * incompatibility: the call compiles, returns a success, and does something
 * other than what the caller asked. supabase-js code passes these because they
 * work there. Saying so once, out loud, is the difference between a five minute
 * fix and a production incident nobody can reproduce.
 *
 * Deduplicated by site and option, because these sit in call paths that run per
 * row, and silent in production, where nobody reads the console and the cost is
 * paid on every call.
 */
const warned = new Set<string>();

export function warnIgnoredOption(site: string, option: string, consequence: string): void {
  const key = `${site}.${option}`;
  if (warned.has(key) || isProduction()) return;
  warned.add(key);
  console.warn(`[motherbase] ${site}: \`${option}\` is accepted and ignored. ${consequence}`);
}
