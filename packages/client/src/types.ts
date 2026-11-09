/**
 * Types shared by every module of the SDK: the result envelope and the client
 * options. A type owned by one module lives in that module's `types.ts`.
 */
import type { ApiEnvelopeContract } from '@motherbase/contracts';
import type { AuthFlowType, KeyValueStorageAdapter, SessionStorageAdapter } from './auth/types.js';
import type { SocketLike } from './realtime/types.js';

/** The envelope non-REST API endpoints (auth, storage, edge) wrap their payload in. */
export interface ApiEnvelope<T = unknown> extends ApiEnvelopeContract<T> {
  code?: string;
  requestId?: string;
  pager?: Record<string, unknown>;
}

/**
 * The uniform result envelope every data/auth/storage call resolves to.
 * `error` is `null` on success; `data` is `null` on failure. Never throws for
 * expected API errors: only for programmer misuse.
 */
export interface MotherbaseResponse<T> {
  data: T | null;
  error: MotherbaseError | null;
}

/** Supabase-shaped error object. */
export interface MotherbaseError {
  message: string;
  /** HTTP status code, when the failure came from an HTTP response. */
  status?: number;
  /** Backend/app error code, when present. */
  code?: string;
  /**
   * Correlation id of the failed request, from the `x-request-id` response
   * header. The same id is on the server-side log line, so quoting it in a bug
   * report (or logging it beside your own error) is what makes an intermittent
   * 500 findable.
   */
  requestId?: string;
}

/**
 * The supabase-js-shaped half of the options.
 *
 * supabase-js nests its options under `auth`, `db`, `global` and `realtime`.
 * Ported code passes them that way, and silently dropping them is the worst
 * possible outcome: `{ auth: { persistSession: true } }` looks like it works
 * and the user is signed out on every reload. Both spellings are accepted; the
 * flat (native) one wins where they collide.
 */
export interface SupabaseStyleOptions {
  auth?: {
    /** Refresh on 401 and, with `startAutoRefresh()`, on a timer. Default true. */
    autoRefreshToken?: boolean;
    /**
     * `true` (the default in a browser) persists the session to localStorage
     * when no explicit storage is given. `false` keeps it in memory.
     */
    persistSession?: boolean;
    /** Read the OAuth token out of the URL on construction. Default true in a browser. */
    detectSessionInUrl?: boolean;
    /** Either adapter shape: supabase-js's key/value store or the native one. */
    storage?: KeyValueStorageAdapter | SessionStorageAdapter;
    /** Storage key. Defaults to `motherbase.session`. */
    storageKey?: string;
    /**
     * `implicit` (the default) returns the session in the redirect's URL
     * fragment. `pkce` returns `?code=` instead, exchanged automatically on
     * load (or by `auth.exchangeCodeForSession(code)`) with the verifier this
     * browser kept, so a leaked redirect URL is worth nothing on its own.
     */
    flowType?: AuthFlowType;
    /** Accepted for supabase-js compatibility; has no effect. */
    debug?: boolean;
  };
  db?: {
    /** Default schema for `from()` and `rpc()`. Only `public` is exposed today. */
    schema?: string;
  };
  global?: {
    /** Headers sent with every request. */
    headers?: Record<string, string>;
    /** A `fetch` to use instead of the global one. */
    fetch?: typeof fetch;
  };
  /** Accepted for supabase-js compatibility; has no effect. */
  realtime?: Record<string, unknown>;
}

export interface ClientOptions extends SupabaseStyleOptions {
  /** Where to persist the session. Defaults to in-memory (SSR-safe). */
  storage?: SessionStorageAdapter;
  /** Refresh the access token automatically on a 401. Default: true. */
  autoRefresh?: boolean;
  /** Override the fetch implementation (for SSR or tests). */
  fetch?: typeof fetch;
  /** Extra headers merged into every request (e.g. a custom `apikey`). */
  headers?: Record<string, string>;
  /**
   * Align the behaviours that differ from supabase-js but share its spelling.
   *
   * A missing method fails loudly. A method that exists and behaves differently
   * does not, and that is what breaks a ported app in production. Differences
   * are recorded in COMPATIBILITY.md:
   *
   *   - `update()` / `delete()` whose filter matches nothing answer 404 here and
   *     an empty array in supabase-js.
   *
   * Writes already require `.select()` to return rows in every mode.
   *
   * NOT covered, on purpose: an unfiltered `delete()` stays refused with 400.
   * Parity there means removing a guard against deleting a whole table from a
   * typo, and no migration is worth that. Add `.neq('id', 0)`, or run it from
   * the SQL editor.
   */
  compat?: 'supabase';
  /**
   * Inject a socket.io factory for realtime (tests / custom transports).
   * When omitted, `socket.io-client` is imported lazily at connect time.
   */
  realtimeIoFactory?: (url: string, opts: Record<string, unknown>) => SocketLike;
}
