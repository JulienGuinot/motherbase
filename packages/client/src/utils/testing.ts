/**
 * Test-only client: run a query as a specific user, or as nobody.
 *
 * A row level security policy is a claim about who can see what, and the only
 * honest way to check it is to issue the same query as several callers and
 * compare the results. Without this, doing that in a test means creating users
 * and signing in as each of them through the real auth flow, which is slow
 * enough that most policies end up untested and wrong.
 *
 * ```ts
 * const asAlice = createTestClient(url, secretKey, { as: alice.id })
 * const asBob   = createTestClient(url, secretKey, { as: bob.id })
 * const asAnon  = createTestClient(url, secretKey, { as: 'anon' })
 *
 * expect((await asAlice.from('notes').select('*')).data).toHaveLength(1)
 * expect((await asBob.from('notes').select('*')).data).toHaveLength(0)
 * ```
 *
 * This is a server-side tool. It needs the project's SECRET key, which bypasses
 * RLS and must never reach a browser, so importing this module from application
 * code is a mistake even though nothing here can stop you. The server refuses
 * the impersonation header outright when the key is anything else, so the worst
 * case is a failed request rather than a privilege escalation.
 */
import { createClient, MotherbaseClient } from '../index.js';
import { memoryStorage } from '../auth/session.js';
import type { ClientOptions } from '../types.js';
import type { GenericDatabase, GenericSchema, DefaultSchemaName, SchemaOf } from '../database/types.js';

/** The header the server reads. Exported so a raw fetch can do the same thing. */
export const IMPERSONATE_HEADER = 'x-motherbase-impersonate';

export interface TestClientOptions extends ClientOptions {
  /**
   * Who to run as: a user id, `'anon'` for a signed-out visitor, or
   * `'service_role'` to keep the secret key's own bypass-everything identity.
   */
  as: string;
}

export function createTestClient<
  Database = GenericDatabase,
  SchemaName = DefaultSchemaName<Database>,
  Schema extends GenericSchema = SchemaOf<Database, SchemaName>,
>(
  url: string,
  secretKey: string,
  options: TestClientOptions,
): MotherbaseClient<Database, SchemaName, Schema> {
  if (!secretKey?.startsWith('mb_secret_')) {
    // Fail here rather than at the first query: a test that ran as the wrong
    // caller and passed is the failure this whole module exists to prevent.
    throw new Error(
      'createTestClient needs the project secret key (mb_secret_…). A publishable key cannot impersonate, '
        + 'and the server refuses the header with a 403.',
    );
  }

  const { as, ...rest } = options;
  return createClient<Database, SchemaName, Schema>(url, secretKey, {
    // A fresh in-memory session per client, so two clients in one test file
    // cannot share (or clobber) each other's stored session.
    storage: memoryStorage(),
    ...rest,
    headers: {
      ...rest.headers,
      // `service_role` is the absence of impersonation: the secret key already
      // is service_role, so sending a header would only add a lookup.
      ...(as === 'service_role' ? {} : { [IMPERSONATE_HEADER]: as }),
    },
  });
}
