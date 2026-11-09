import {
  createClient,
  cookieStorage,
  type MotherbaseClient,
  type ClientOptions,
  type GenericDatabase,
  type GenericSchema,
  type DefaultSchemaName,
  type SchemaOf,
} from '@motherbase/client';

/** Options shared by the browser and server clients. */
export interface SsrOptions {
  /**
   * Cookie the session is stored in. Both halves have to agree: the browser
   * writes it and the server reads it, so a key set here must be set on
   * `createServerClient` and `updateSession` too. Defaults to
   * `SESSION_COOKIE_KEY` (`motherbase.session`).
   */
  cookieKey?: string;
  /**
   * Hide the session cookie from `document.cookie`. Server side only, and off
   * by default on purpose: `createBrowserClient` reads that same cookie, so
   * turning this on without giving the browser client its own storage
   * (`storage: localStorageStorage()`) signs the browser half out.
   *
   * It does not make the cookie trustworthy either: it is unsigned, and a
   * server-side caller can still forge one. `auth.getSession()` asks the
   * server, so the user it returns is the verified one.
   */
  httpOnly?: boolean;
}

/**
 * Create a Motherbase client for use in Client Components / browser code.
 * Session is persisted to `document.cookie` (readable by the server on the
 * next request) unless a custom `storage` is supplied.
 *
 * Prefer this over `createClient` from `@motherbase/client` in a Next.js app:
 * the bare client keeps the session in memory, where the server cannot see it.
 * Takes the same `Database` type parameter as `createClient`.
 */
export function createBrowserClient<
  Database = GenericDatabase,
  SchemaName = DefaultSchemaName<Database>,
  Schema extends GenericSchema = SchemaOf<Database, SchemaName>,
>(
  url: string,
  key?: string,
  options: ClientOptions & SsrOptions = {},
): MotherbaseClient<Database, SchemaName, Schema> {
  const { cookieKey, httpOnly: _httpOnly, ...clientOptions } = options;
  return createClient<Database, SchemaName, Schema>(url, key, {
    ...clientOptions,
    storage: options.storage ?? cookieStorage(cookieKey ? { key: cookieKey } : {}),
  });
}
