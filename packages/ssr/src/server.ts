import {
  createClient,
  serverCookieStorage,
  type MotherbaseClient,
  type ClientOptions,
  type CookieMethods,
  type GenericDatabase,
  type GenericSchema,
  type DefaultSchemaName,
  type SchemaOf,
} from '@motherbase/client';
import type { SsrOptions } from './browser.js';

/**
 * Create a Motherbase client for use in Server Components, Route Handlers,
 * or Server Actions. Reads/writes the session through the supplied
 * `cookies` methods (typically `next/headers` `cookies()`).
 *
 * Writing a cookie from a Server Component is forbidden by Next.js. The client
 * absorbs that (and warns once in development), because the session is meant to
 * be refreshed by `updateSession` in `proxy.ts` / `middleware.ts` instead. If
 * you never set that up, this client reads a cookie nobody writes and every
 * `auth.getSession()` returns null.
 *
 * Takes the same `Database` type parameter as `createClient`.
 */
export function createServerClient<
  Database = GenericDatabase,
  SchemaName = DefaultSchemaName<Database>,
  Schema extends GenericSchema = SchemaOf<Database, SchemaName>,
>(
  url: string,
  key: string | undefined,
  options: { cookies: CookieMethods } & SsrOptions & Omit<ClientOptions, 'storage'>,
): MotherbaseClient<Database, SchemaName, Schema> {
  const { cookies, cookieKey, httpOnly, ...rest } = options;
  return createClient<Database, SchemaName, Schema>(url, key, {
    ...rest,
    storage: serverCookieStorage(cookies, cookieKey, { httpOnly }),
  });
}
