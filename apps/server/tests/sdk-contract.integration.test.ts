import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { REALTIME_TOPIC_EVENTS } from '@motherbase/contracts';
import { createClient, FunctionsHttpError, memoryStorage, type MotherbaseClient } from '../../../packages/client/src/index';
import type { SocketLike } from '../../../packages/client/src/index';
import {
  CLIENT_README_PATH,
  compatCase,
  compatRows,
  writeCompatibilityMarkdown,
} from './sdk-contract-matrix';
import {
  COMPAT_FUNCTION,
  COMPAT_TABLE,
  createSdkContractLiveHarness,
  resetCompatRows,
  type SdkContractLiveHarness,
} from './sdk-contract-live';

/**
 * The supabase-js compatibility matrix, expressed as tests.
 *
 * Each `compatCase` carries its own status tag and note, and writing them out is
 * the ONLY way `packages/client/COMPATIBILITY.md` changes. `unsupported` cases
 * assert today's failure, so the moment a feature lands the case fails and the
 * document has to be regenerated. Do not soften an assertion to make a case
 * pass: change the tag instead.
 */

let harness: SdkContractLiveHarness;
/** Signed-in client, reused by the data cases. */
let db: MotherbaseClient;

const ROW_IDS = ['i1', 'i2', 'i3'];

function ids(rows: unknown): string[] {
  return (rows as Array<{ id: string }>).map(row => row.id).sort();
}

/** Raw REST probe for query syntax the SDK cannot even express today. */
async function restProbe(query: string): Promise<Response> {
  return fetch(`${harness.baseUrl}/rest/v1/${COMPAT_TABLE}?${query}`, {
    headers: { Authorization: `Bearer ${harness.token}` },
  });
}

/** A client holding the fixture user's session, as an app reloading with a stored one would. */
async function authedClient(): Promise<MotherbaseClient> {
  const storage = memoryStorage();
  await storage.set({ accessToken: harness.token, user: { id: harness.user.id, email: harness.user.email } });
  return createClient(harness.baseUrl, undefined, { storage });
}

/**
 * Assert a supabase-js auth method is not on `client.auth`. Better Auth's
 * client turns any name into a request, so the call reaches the server and is
 * answered 404 rather than failing with "is not a function".
 */
async function expectNoSuchMethod(client: MotherbaseClient, name: string): Promise<void> {
  const method = (client.auth as unknown as Record<string, (body: object) => Promise<{ error: { status: number } | null }>>)[name];
  expect((await method({})).error?.status).toBe(404);
}

/**
 * A client on its own throwaway account. Cases that revoke a session must use
 * this: signing out the shared fixture token would break every later case.
 */
async function disposableClient(tag: string): Promise<{ client: MotherbaseClient; email: string }> {
  const email = harness.trackEmail(`sdk-compat-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`);
  const client = createClient(harness.baseUrl);
  const signUp = await client.auth.signUp.email({ email, password: 'compat-password-1', name: email });
  expect(signUp.error).toBeNull();
  return { client, email };
}

interface FakeSocketHarness {
  socket: SocketLike;
  emitted: Array<{ event: string; args: unknown[] }>;
  deliver: (event: string, payload: unknown) => void;
}

/** Same fake transport convention as `realtime-channel.unit.test.ts`. */
function fakeSocket(): FakeSocketHarness {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const emitted: Array<{ event: string; args: unknown[] }> = [];
  const socket: SocketLike = {
    connected: true,
    on: (event, cb) => listeners.set(event, [...(listeners.get(event) ?? []), cb]),
    off: (event, cb) => {
      if (!cb) listeners.delete(event);
      else listeners.set(event, (listeners.get(event) ?? []).filter(fn => fn !== cb));
    },
    emit: (event, ...args) => {
      emitted.push({ event, args });
      const ack = args[args.length - 1];
      if (typeof ack === 'function') {
        if (event === REALTIME_TOPIC_EVENTS.join) (ack as (a: unknown) => void)({ status: 'ok', postgres_changes: [] });
        else (ack as (a: unknown) => void)('ok');
      }
    },
    disconnect: () => {},
  };
  return {
    socket,
    emitted,
    deliver: (event, payload) => {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
  };
}

function realtimeClient(): { client: MotherbaseClient; socket: FakeSocketHarness } {
  const socket = fakeSocket();
  return {
    client: createClient('http://realtime.invalid', undefined, { realtimeIoFactory: () => socket.socket }),
    socket,
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 10));

beforeAll(async () => {
  harness = await createSdkContractLiveHarness(vi.spyOn);
  db = await authedClient();
}, 60_000);

afterAll(async () => {
  const result = writeCompatibilityMarkdown();
  if (!result.written) {
    console.error(`[sdk-contract] COMPATIBILITY.md not regenerated: ${result.reason}`);
  }
  await harness?.close();
});

// ── Client ───────────────────────────────────────────────────────────────────

describe('Client', () => {
  compatCase(
    {
      id: 'client.createClient',
      section: 'Client',
      surface: "createClient(url, key, options)",
      status: 'supported',
      note: 'The key is sent as an apikey header. Options cover session storage, a fetch override and extra headers.',
    },
    async () => {
      const client = createClient(harness.baseUrl, harness.publishableKey);
      expect(client.key).toBe(harness.publishableKey);
      expect((await client.from(COMPAT_TABLE).select('id')).error).toBeNull();
    },
  );

  compatCase(
    {
      id: 'client.rpc',
      section: 'Client',
      surface: 'client.rpc(fn, args)',
      status: 'supported',
      note: 'POST and GET /rest/v1/rpc/:fn resolve a public function from the catalog and call it with named arguments inside the caller RLS transaction. SECURITY DEFINER functions are refused unless an operator allowlists them, and an unknown function is a 404.',
    },
    async () => {
      const result = await db.rpc(COMPAT_FUNCTION, { min_qty: 20 });
      expect(result.error).toBeNull();
      expect((result.data as Array<{ id: string }>).map(r => r.id)).toEqual(['i2', 'i3']);
      // An unknown function is still an honest 404.
      const missing = await db.rpc('sdk_compat_no_such_function', {});
      expect(missing.error).toMatchObject({ status: 404 });
    },
  );

  compatCase(
    {
      id: 'client.schema',
      section: 'Client',
      surface: "client.schema('other') / createClient(url, key, { db: { schema } })",
      status: 'partial',
      note: "schema('public') is the client. schema(name).rpc() calls functions in another schema through the Content-Profile/Accept-Profile headers, for the schemas a feature exposes (Queues' pgmq_public); any other is refused with PGRST106. Tables are served from public only, so schema(name).from() and the db.schema constructor option throw with the reason rather than reading public under another name.",
    },
    async () => {
      expect(db.schema('public')).toBe(db);
      const refused = await db.schema('sdk_compat_not_exposed').rpc('anything');
      expect(refused.error).toMatchObject({ status: 406 });
      expect(() => db.schema('other').from('t')).toThrow(/public schema only/);
      expect(() => createClient(harness.baseUrl, undefined, { db: { schema: 'other' } })).toThrow(/not exposed/);
    },
  );

  compatCase(
    {
      id: 'client.options-shape',
      section: 'Client',
      surface: 'createClient(url, key, { auth, db, global })',
      status: 'supported',
      note: "supabase-js nests its options under auth, db, global and realtime, and ported code passes them that way. Both spellings are read, the flat one winning where they collide, so { auth: { persistSession } } and { global: { headers, fetch } } take effect instead of being silently dropped. auth.storage accepts either adapter shape, including a React Native AsyncStorage.",
    },
    async () => {
      const seen: string[] = [];
      const store = new Map<string, string>();
      const client = createClient(harness.baseUrl, undefined, {
        global: { headers: { 'x-compat-global': '1' } },
        auth: {
          persistSession: true,
          // The supabase-js adapter shape: a string key/value store.
          storage: {
            getItem: key => store.get(key) ?? null,
            setItem: (key, value) => void store.set(key, value),
            removeItem: key => void store.delete(key),
          },
          storageKey: 'compat-session',
        },
      });
      client.auth.onAuthStateChange(event => void seen.push(event));
      const signIn = await client.auth.signIn.email({ email: harness.user.email, password: harness.user.password });
      expect(signIn.error).toBeNull();
      // The key/value adapter was actually written through, under the given key.
      expect(store.has('compat-session')).toBe(true);
    },
  );

  compatCase(
    {
      id: 'client.getChannels',
      section: 'Client',
      surface: 'client.getChannels()',
      status: 'supported',
      note: 'Returns the channels this client has created, as supabase-js does.',
    },
    () => {
      const { client } = realtimeClient();
      expect(client.getChannels()).toEqual([]);
      const channel = client.channel('compat-list');
      expect(client.getChannels()).toEqual([channel]);
    },
  );

  compatCase(
    {
      id: 'client.typed-database',
      section: 'Client',
      surface: 'createClient<Database>(url, key)',
      status: 'supported',
      note: 'motherbase gen types typescript emits the supabase-js Database shape (Row, Insert, Update, Relationships, Enums, Functions) from the Postgres catalog, and createClient<Database> types from() and rpc() from it. Unknown columns are still rejected at runtime as well.',
    },
    async () => {
      const result = await db.from(COMPAT_TABLE).select('does_not_exist');
      expect(result.error).toMatchObject({ status: 400 });
      expect(result.error?.message).toContain('does_not_exist');
    },
  );
});

// ── Data: verbs ──────────────────────────────────────────────────────────────

describe('Data verbs', () => {
  compatCase(
    {
      id: 'data.verb.delete',
      section: 'Data · verbs',
      surface: 'from(t).delete().eq(col, v)',
      status: 'supported',
      note: 'Deleted rows are returned when .select() is requested. The delete is bound to the row versions whose realtime audience was captured.',
    },
    async () => {
      const client = await authedClient();
      expect((await client.from(COMPAT_TABLE).insert({ id: 'd1', owner_id: harness.user.id, label: 'del', qty: 1, tag: 'z' })).error).toBeNull();
      const result = await client.from(COMPAT_TABLE).delete().eq('id', 'd1').select();
      expect(result.error).toBeNull();
      expect(ids(result.data)).toEqual(['d1']);
      await resetCompatRows();
    },
  );

  compatCase(
    {
      id: 'data.verb.delete.unfiltered',
      section: 'Data · verbs',
      surface: 'from(t).delete()',
      status: 'partial',
      note: 'An unfiltered delete is refused with 400 for non-admin callers, on purpose. supabase-js would delete every visible row.',
    },
    async () => {
      const result = await db.from(COMPAT_TABLE).delete();
      expect(result.error).toMatchObject({ status: 400 });
      expect(result.error?.message).toContain('filter is required');
    },
  );

  compatCase(
    {
      id: 'data.verb.insert.bulk',
      section: 'Data · verbs',
      surface: 'from(t).insert([rowA, rowB])',
      status: 'supported',
      note: 'An array body is compiled into one multi-row INSERT. Rows may declare different key subsets; a key a row omits is written as DEFAULT so the column default applies.',
    },
    async () => {
      const result = await db.from(COMPAT_TABLE).insert([
        { id: 'b1', owner_id: harness.user.id, label: 'b1', qty: 1, tag: 'z' },
        { id: 'b2', owner_id: harness.user.id, label: 'b2', qty: 2, tag: 'z' },
      ] as never).select();
      expect(result.error).toBeNull();
      expect((result.data as Array<{ id: string }>).map(r => r.id)).toEqual(['b1', 'b2']);
      await resetCompatRows();
    },
  );

  compatCase(
    {
      id: 'data.verb.insert.single',
      section: 'Data · verbs',
      surface: 'from(t).insert(row)',
      status: 'supported',
      note: 'One row per call; .select() returns it with server defaults applied. Without .select(), data is null.',
    },
    async () => {
      const client = await authedClient();
      const result = await client
        .from(COMPAT_TABLE)
        .insert({ id: 'n1', owner_id: harness.user.id, label: 'new', qty: 5, tag: 'z' }).select();
      expect(result.error).toBeNull();
      expect(result.data).toMatchObject([{ id: 'n1', is_done: false }]);
      await resetCompatRows();
    },
  );

  compatCase(
    {
      id: 'data.verb.select',
      section: 'Data · verbs',
      surface: "from(t).select('*')",
      status: 'supported',
      note: 'Awaitable, resolves to { data, error } and never throws for an API error.',
    },
    async () => {
      const result = await db.from(COMPAT_TABLE).select('*');
      expect(result.error).toBeNull();
      expect(ids(result.data)).toEqual(ROW_IDS);
    },
  );

  compatCase(
    {
      id: 'data.verb.update',
      section: 'Data · verbs',
      surface: 'from(t).update(values).eq(col, v)',
      status: 'supported',
      note: 'Returns the updated rows when .select() is requested. A filter that matches nothing is a 404 rather than an empty array.',
    },
    async () => {
      const client = await authedClient();
      const result = await client.from(COMPAT_TABLE).update({ label: 'updated' }).eq('id', 'i1').select();
      expect(result.error).toBeNull();
      expect(result.data).toMatchObject([{ id: 'i1', label: 'updated' }]);
      const missing = await client.from(COMPAT_TABLE).update({ label: 'x' }).eq('id', 'nope');
      expect(missing.error).toMatchObject({ status: 404 });
      await resetCompatRows();
    },
  );

  compatCase(
    {
      id: 'data.verb.upsert',
      section: 'Data · verbs',
      surface: 'from(t).upsert(rows, { onConflict })',
      status: 'supported',
      note: 'A real INSERT ... ON CONFLICT DO UPDATE. The conflict target is ?on_conflict= or the catalog primary key, and a row that actually conflicted emits an updated realtime event rather than a created one.',
    },
    async () => {
      const result = await db
        .from(COMPAT_TABLE)
        .upsert({ id: 'i1', owner_id: harness.user.id, label: 'conflict', qty: 99, tag: 'z' }).select();
      expect(result.error).toBeNull();
      expect(result.data).toMatchObject([{ id: 'i1', label: 'conflict', qty: 99 }]);
      await resetCompatRows();
    },
  );

  compatCase(
    {
      id: 'data.verb.write-returning',
      section: 'Data · verbs',
      surface: 'from(t).insert(row).select()',
      status: 'supported',
      note: 'Writes return no rows by default. Add .select() to opt into a representation, subject to the caller’s SELECT policy.',
    },
    async () => {
      const client = await authedClient();
      const withoutSelect = await client
        .from(COMPAT_TABLE)
        .insert({ id: 'r1', owner_id: harness.user.id, label: 'ret', qty: 7, tag: 'z' });
      expect(withoutSelect.error).toBeNull();
      expect(withoutSelect.data).toBeNull();
      const withSelect = await client.from(COMPAT_TABLE)
        .insert({ id: 'r2', owner_id: harness.user.id, label: 'ret', qty: 7, tag: 'z' }).select('id');
      expect(withSelect.error).toBeNull();
      expect(withSelect.data).toEqual([{ id: 'r2' }]);
      await resetCompatRows();
    },
  );
});

// ── Data: filters ────────────────────────────────────────────────────────────

describe('Data filters', () => {
  compatCase(
    {
      id: 'data.filter.contains',
      section: 'Data · filters',
      surface: 'from(t).contains(col, value)',
      status: 'supported',
      note: 'Compiled to the containment operator. It applies to array, range and jsonb columns; used on a scalar column it is a 400 rather than a silently empty result.',
    },
    async () => {
      expect(ids((await db.from(COMPAT_TABLE).select('id').contains('tags', ['blue'])).data)).toEqual(['i1', 'i2']);
      // tag is scalar text, so containment does not apply: a caller error, 400.
      const res = await restProbe('tag=cs.%7Ba%7D');
      expect(res.status).toBe(400);
    },
  );

  compatCase(
    {
      id: 'data.filter.containedBy-overlaps',
      section: 'Data · filters',
      surface: 'from(t).containedBy(col, v) / .overlaps(col, v)',
      status: 'supported',
      note: 'Compiled to the contained-by and overlap operators, on array and range columns.',
    },
    async () => {
      expect(ids((await db.from(COMPAT_TABLE).select('id').containedBy('tags', ['red', 'blue'])).data)).toEqual(['i1', 'i2']);
      expect(ids((await db.from(COMPAT_TABLE).select('id').overlaps('tags', ['green'])).data)).toEqual(['i3']);
    },
  );

  compatCase(
    {
      id: 'data.filter.eq',
      section: 'Data · filters',
      surface: 'from(t).eq(col, v)',
      status: 'supported',
      note: 'Compiled to a parameterised equality.',
    },
    async () => {
      expect(ids((await db.from(COMPAT_TABLE).select('id').eq('qty', 20)).data)).toEqual(['i2']);
    },
  );

  compatCase(
    {
      id: 'data.filter.filter',
      section: 'Data · filters',
      surface: 'from(t).filter(col, op, value)',
      status: 'supported',
      note: 'The escape hatch reaches any operator in the dialect, including ones with no dedicated builder method.',
    },
    async () => {
      // isdistinct has no dedicated builder method, so it can only be reached
      // through the escape hatch. NULL-safe inequality keeps the null-note row.
      expect(ids((await db.from(COMPAT_TABLE).select('id').filter('note', 'isdistinct', 'first')).data)).toEqual(['i2', 'i3']);
    },
  );

  compatCase(
    {
      id: 'data.filter.gt-gte-lt-lte',
      section: 'Data · filters',
      surface: 'from(t).gt/gte/lt/lte(col, v)',
      status: 'supported',
      note: 'All four compile to the matching SQL comparison.',
    },
    async () => {
      expect(ids((await db.from(COMPAT_TABLE).select('id').gt('qty', 10)).data)).toEqual(['i2', 'i3']);
      expect(ids((await db.from(COMPAT_TABLE).select('id').gte('qty', 20)).data)).toEqual(['i2', 'i3']);
      expect(ids((await db.from(COMPAT_TABLE).select('id').lt('qty', 30)).data)).toEqual(['i1', 'i2']);
      expect(ids((await db.from(COMPAT_TABLE).select('id').lte('qty', 20)).data)).toEqual(['i1', 'i2']);
    },
  );

  compatCase(
    {
      id: 'data.filter.ilike',
      section: 'Data · filters',
      surface: 'from(t).ilike(col, pattern)',
      status: 'supported',
      note: 'Case-insensitive ILIKE with PostgREST anchoring, so %ETA means "ends with eta" rather than a substring match.',
    },
    async () => {
      // Case-insensitive, but still anchored: %ETA matches "Beta", %ET does not.
      expect(ids((await db.from(COMPAT_TABLE).select('id').ilike('label', '%ETA')).data)).toEqual(['i2']);
      expect(ids((await db.from(COMPAT_TABLE).select('id').ilike('label', '%ET')).data)).toEqual([]);
    },
  );

  compatCase(
    {
      id: 'data.filter.in',
      section: 'Data · filters',
      surface: 'from(t).in(col, [..])',
      status: 'supported',
      note: 'Compiled to an IN list. The client quotes any value that needs it, so a value containing a comma stays one value instead of splitting into two.',
    },
    async () => {
      expect(ids((await db.from(COMPAT_TABLE).select('id').in('id', ['i1', 'i3'])).data)).toEqual(['i1', 'i3']);
      // One value that happens to contain a comma. If quoting were missing this
      // would split into 'alpha' and 'Beta' and wrongly match two rows.
      expect(ids((await db.from(COMPAT_TABLE).select('id').in('label', ['alpha,Beta'])).data)).toEqual([]);
      expect(ids((await db.from(COMPAT_TABLE).select('id').in('label', ['alpha', 'Beta'])).data)).toEqual(['i1', 'i2']);
    },
  );

  compatCase(
    {
      id: 'data.filter.is',
      section: 'Data · filters',
      surface: 'from(t).is(col, null | true | false)',
      status: 'supported',
      note: 'is null becomes IS NULL. Boolean forms become an equality.',
    },
    async () => {
      expect(ids((await db.from(COMPAT_TABLE).select('id').is('note', null)).data)).toEqual(['i2']);
      expect(ids((await db.from(COMPAT_TABLE).select('id').is('is_done', true)).data)).toEqual(['i1']);
    },
  );

  compatCase(
    {
      id: 'data.filter.json-path',
      section: 'Data · filters',
      surface: "from(t).eq('col->>key', v)",
      status: 'supported',
      note: 'A jsonb path operand is parsed and compiled. The text arrow compares as text, the object arrow compares as jsonb, and every path segment is bound as a parameter rather than interpolated.',
    },
    async () => {
      expect(ids((await db.from(COMPAT_TABLE).select('id').eq('meta->>kind', 'x')).data)).toEqual(['i1', 'i3']);
      expect(ids((await db.from(COMPAT_TABLE).select('id').gt('meta->>level', '2')).data)).toEqual(['i3']);
    },
  );

  compatCase(
    {
      id: 'data.filter.like',
      section: 'Data · filters',
      surface: 'from(t).like(col, pattern)',
      status: 'supported',
      note: 'Case-sensitive LIKE with PostgREST anchoring. * is translated to %, and an unanchored pattern is an exact match.',
    },
    async () => {
      // Anchoring is honoured: %eta matches the stored "Beta".
      expect(ids((await db.from(COMPAT_TABLE).select('id').like('label', '%eta')).data)).toEqual(['i2']);
      // And it is case-sensitive, so the same pattern uppercased matches nothing.
      expect(ids((await db.from(COMPAT_TABLE).select('id').like('label', '%ETA')).data)).toEqual([]);
      // An unanchored pattern is an exact match, not a substring one.
      expect(ids((await db.from(COMPAT_TABLE).select('id').like('label', 'eta')).data)).toEqual([]);
    },
  );

  compatCase(
    {
      id: 'data.filter.match',
      section: 'Data · filters',
      surface: 'from(t).match({ col: v })',
      status: 'supported',
      note: 'Expanded into one equality filter per key, all ANDed together.',
    },
    async () => {
      expect(ids((await db.from(COMPAT_TABLE).select('id').match({ tag: 'a', is_done: false })).data)).toEqual(['i3']);
    },
  );

  compatCase(
    {
      id: 'data.filter.neq',
      section: 'Data · filters',
      surface: 'from(t).neq(col, v)',
      status: 'supported',
      note: 'Compiled to !=, so NULL values are excluded exactly as in PostgREST.',
    },
    async () => {
      expect(ids((await db.from(COMPAT_TABLE).select('id').neq('qty', 20)).data)).toEqual(['i1', 'i3']);
    },
  );

  compatCase(
    {
      id: 'data.filter.not',
      section: 'Data · filters',
      surface: 'from(t).not(col, op, value)',
      status: 'supported',
      note: 'Emitted as a not. prefix and honoured on every operator, including not.is.null.',
    },
    async () => {
      expect(ids((await db.from(COMPAT_TABLE).select('id').not('tag', 'eq', 'a')).data)).toEqual(['i2']);
      expect(ids((await db.from(COMPAT_TABLE).select('id').not('note', 'is', null)).data)).toEqual(['i1', 'i3']);
    },
  );

  compatCase(
    {
      id: 'data.filter.or',
      section: 'Data · filters',
      surface: "from(t).or('a.eq.1,b.eq.2')",
      status: 'supported',
      note: 'Emitted as an or group and compiled recursively, so a nested and() inside it works too.',
    },
    async () => {
      expect(ids((await db.from(COMPAT_TABLE).select('id').or('qty.eq.10,qty.eq.20')).data)).toEqual(['i1', 'i2']);
      // Nested group: qty = 10 OR (tag = a AND qty > 25) selects i1 and i3.
      expect(ids((await db.from(COMPAT_TABLE).select('id').or('qty.eq.10,and(tag.eq.a,qty.gt.25)')).data)).toEqual(['i1', 'i3']);
    },
  );

  compatCase(
    {
      id: 'data.filter.range-operators',
      section: 'Data · filters',
      surface: 'from(t).rangeGt/rangeGte/rangeLt/rangeLte/rangeAdjacent',
      status: 'supported',
      note: 'Emitted as the strictly-left, strictly-right, not-extending and adjacent operators. The compat fixture has no range column, so this pins the emitted encoding rather than a result set.',
    },
    () => {
      expect(decodeURIComponent(db.from(COMPAT_TABLE).select('id').rangeGt('span', '[1,5)').toPath())).toContain('span=sr.');
      expect(decodeURIComponent(db.from(COMPAT_TABLE).select('id').rangeAdjacent('span', '[1,5)').toPath())).toContain('span=adj.');
    },
  );

  compatCase(
    {
      id: 'data.filter.textSearch',
      section: 'Data · filters',
      surface: 'from(t).textSearch(col, query)',
      status: 'supported',
      note: 'Maps to the four text-search operators, with an optional configuration rendered in parentheses.',
    },
    async () => {
      expect(ids((await db.from(COMPAT_TABLE).select('id').textSearch('label', 'alpha')).data)).toEqual(['i1']);
      expect(ids((await db.from(COMPAT_TABLE).select('id').textSearch('label', 'alpha', { config: 'english' })).data)).toEqual(['i1']);
    },
  );
});

// ── Data: modifiers ──────────────────────────────────────────────────────────

describe('Data modifiers', () => {
  compatCase(
    {
      id: 'data.modifier.abortSignal',
      section: 'Data · modifiers',
      surface: 'from(t).select().abortSignal(signal)',
      status: 'supported',
      note: 'The signal is handed to fetch, so an aborted query settles as an error instead of resolving rows.',
    },
    async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await db.from(COMPAT_TABLE).select('id').abortSignal(controller.signal);
      expect(result.error).not.toBeNull();
    },
  );

  compatCase(
    {
      id: 'data.modifier.setHeader',
      section: 'Data · modifiers',
      surface: 'from(t).select().setHeader(name, value)',
      status: 'supported',
      note: 'Sends the header with that request only. It is how a CAPTCHA token reaches a table guarded under Attack Protection.',
    },
    async () => {
      const result = await db.from(COMPAT_TABLE).select('id').eq('id', 'i1').setHeader('x-request-tag', 'contract');
      expect(result.error).toBeNull();
      expect(ids(result.data)).toEqual(['i1']);
    },
  );

  compatCase(
    {
      id: 'data.modifier.csv-explain',
      section: 'Data · modifiers',
      surface: 'from(t).select().csv() / .explain()',
      status: 'partial',
      note: 'csv() returns RFC 4180 text. explain() is admin-only: the server answers 403 for a normal caller, so an application cannot rely on it.',
    },
    async () => {
      const csv = await db.from(COMPAT_TABLE).select('id,label').order('id').csv();
      expect(csv.error).toBeNull();
      expect(String(csv.data).split(/\r?\n/)[0]).toBe('id,label');
      // The fixture user is not an ADMIN, so the plan is refused.
      const plan = await db.from(COMPAT_TABLE).select('id').explain();
      expect(plan.error).not.toBeNull();
    },
  );

  compatCase(
    {
      id: 'data.modifier.limit',
      section: 'Data · modifiers',
      surface: 'from(t).limit(n)',
      status: 'supported',
      note: 'Sent as ?limit=n. The server caps it at the console-tunable api.rest.maxRows (1000 by default).',
    },
    async () => {
      const result = await db.from(COMPAT_TABLE).select('id').order('qty').limit(2);
      expect(ids(result.data)).toEqual(['i1', 'i2']);
    },
  );

  compatCase(
    {
      id: 'data.modifier.limit.foreignTable',
      section: 'Data · modifiers',
      surface: "from(t).limit(n, { foreignTable })",
      status: 'supported',
      note: 'Emitted as <relation>.limit and applied to the embedded subquery, so a parent keeps all its rows while its children are capped.',
    },
    async () => {
      const result = await db
        .from('sdk_compat_owner')
        .select('id,sdk_compat_item(id)')
        .limit(1, { foreignTable: 'sdk_compat_item' } as never);
      expect(result.error).toBeNull();
      expect((result.data as Array<{ sdk_compat_item: unknown[] }>)[0].sdk_compat_item).toHaveLength(1);
    },
  );

  compatCase(
    {
      id: 'data.modifier.maybeSingle',
      section: 'Data · modifiers',
      surface: 'from(t).select().maybeSingle()',
      status: 'supported',
      note: 'Resolves the first row or null. Applied client side.',
    },
    async () => {
      expect((await db.from(COMPAT_TABLE).select('*').eq('id', 'i2').maybeSingle()).data).toMatchObject({ id: 'i2' });
      expect((await db.from(COMPAT_TABLE).select('*').eq('id', 'nope').maybeSingle()).data).toBeNull();
    },
  );

  compatCase(
    {
      id: 'data.modifier.order',
      section: 'Data · modifiers',
      surface: "from(t).order(col, { ascending })",
      status: 'supported',
      note: 'Multiple order() calls are concatenated into one ?order= list, as PostgREST does.',
    },
    async () => {
      const result = await db.from(COMPAT_TABLE).select('id').order('qty', { ascending: false });
      expect((result.data as Array<{ id: string }>).map(r => r.id)).toEqual(['i3', 'i2', 'i1']);
    },
  );

  compatCase(
    {
      id: 'data.modifier.order.options',
      section: 'Data · modifiers',
      surface: "from(t).order(col, { nullsFirst, referencedTable })",
      status: 'supported',
      note: 'nullsFirst emits the nullsfirst and nullslast qualifiers, and referencedTable scopes the ordering to an embedded relation.',
    },
    () => {
      const path = db
        .from(COMPAT_TABLE)
        .select('id')
        .order('note', { ascending: true, nullsFirst: true } as never)
        .toPath();
      expect(decodeURIComponent(path)).toContain('order=note.asc.nullsfirst');
    },
  );

  compatCase(
    {
      id: 'data.modifier.range',
      section: 'Data · modifiers',
      surface: 'from(t).range(from, to)',
      status: 'supported',
      note: 'Translated to limit and offset. The server also reads a Range request header and always answers with Content-Range and Range-Unit.',
    },
    async () => {
      const result = await db.from(COMPAT_TABLE).select('id').order('qty').range(1, 2);
      expect((result.data as Array<{ id: string }>).map(r => r.id)).toEqual(['i2', 'i3']);
      const res = await restProbe('select=id&order=qty.asc&limit=2');
      expect(res.headers.get('content-range')).toBe('0-1/*');
    },
  );

  compatCase(
    {
      id: 'data.modifier.throwOnError',
      section: 'Data · modifiers',
      surface: 'from(t).select().throwOnError()',
      status: 'supported',
      note: 'Rejects instead of resolving { data: null, error }, so ported code using try/catch works. Without it the envelope is still the default, in both SDKs.',
    },
    async () => {
      const settled = await db.from(COMPAT_TABLE).select('does_not_exist');
      expect(settled.error).not.toBeNull();
      await expect(db.from(COMPAT_TABLE).select('does_not_exist').throwOnError()).rejects.toThrow();
    },
  );

  compatCase(
    {
      id: 'data.modifier.maxAffected-rollback',
      section: 'Data · modifiers',
      surface: 'from(t).update(v).maxAffected(n) / .rollback()',
      status: 'supported',
      note: 'maxAffected rejects and rolls back writes above the limit; rollback performs a dry run. Both preserve transaction atomicity even when no rows are requested.',
    },
    async () => {
      const before = await db.from(COMPAT_TABLE).select('id,label').order('id');
      const capped = await db.from(COMPAT_TABLE).update({ label: 'too many' })
        .in('id', ['i1', 'i2']).maxAffected(1);
      expect(capped.error).toMatchObject({ status: 400 });
      expect(capped.error?.message).toContain('Prefer: max-affected. Nothing was written.');
      const dryRun = await db.from(COMPAT_TABLE).update({ label: 'preview' }).eq('id', 'i1').rollback();
      expect(dryRun.error).toBeNull();
      expect(dryRun.data).toBeNull();
      const after = await db.from(COMPAT_TABLE).select('id,label').order('id');
      expect(after.data).toEqual(before.data);
    },
  );

  compatCase(
    {
      id: 'data.modifier.returns',
      section: 'Data · modifiers',
      surface: 'from(t).select().returns<T>()',
      status: 'supported',
      note: 'A compile-time cast helper. It changes no request, matching supabase-js.',
    },
    () => {
      const before = db.from(COMPAT_TABLE).select('id').toPath();
      const after = db.from(COMPAT_TABLE).select('id').returns<{ id: string }[]>().toPath();
      expect(after).toBe(before);
    },
  );

  compatCase(
    {
      id: 'data.modifier.single',
      section: 'Data · modifiers',
      surface: 'from(t).select().single()',
      status: 'supported',
      note: 'Resolves one row, or a PGRST116 error when the result is not exactly one row. Applied client side.',
    },
    async () => {
      expect((await db.from(COMPAT_TABLE).select('*').eq('id', 'i1').single()).data).toMatchObject({ id: 'i1' });
      expect((await db.from(COMPAT_TABLE).select('*').single()).error).toMatchObject({ code: 'PGRST116' });
    },
  );
});

// ── Data: response ───────────────────────────────────────────────────────────

describe('Data response', () => {
  compatCase(
    {
      id: 'data.response.count',
      section: 'Data · response',
      surface: "from(t).select('*', { count: 'exact' })",
      status: 'supported',
      note: 'Prefer count=exact, planned or estimated is honoured, and the total comes back with a Content-Range header computed in the same transaction as the rows.',
    },
    async () => {
      const result = await db.from(COMPAT_TABLE).select('*', { count: 'exact' } as never);
      expect(result.error).toBeNull();
      expect((result as unknown as Record<string, unknown>).count).toBe(3);
    },
  );

  compatCase(
    {
      id: 'data.response.default-limit',
      section: 'Data · response',
      surface: 'from(t).select() with no limit',
      status: 'supported',
      note: 'An unbounded select returns up to api.rest.maxRows (1000 by default), which is what PostgREST does with db-max-rows and what a Supabase app was built against. One number governs both the default and the ceiling, so lowering it is how you cap an unbounded read.',
    },
    async () => {
      const path = db.from(COMPAT_TABLE).select('*').toPath();
      expect(path).not.toContain('limit=');
      // Proven by the server contract: the ceiling is applied even with no ?limit.
      const res = await restProbe('select=id');
      expect(res.status).toBe(200);
      expect((await res.json()).length).toBeLessThanOrEqual(1000);
    },
  );

  compatCase(
    {
      id: 'data.response.embedding',
      section: 'Data · response',
      surface: "from(t).select('*, author(*)')",
      status: 'supported',
      note: 'Embedded resources compile to correlated LATERAL subqueries inside the same RLS transaction, so embedded rows are policy-filtered too. Aliases, !inner, FK hints, nested filter/order/limit and the count aggregate all work.',
    },
    async () => {
      // Child to parent: owner_ref is a plain FK, so the embed is an object.
      const toOne = await db.from(COMPAT_TABLE).select('id,sdk_compat_owner(name)').eq('id', 'i1');
      expect(toOne.error).toBeNull();
      expect(toOne.data).toEqual([{ id: 'i1', sdk_compat_owner: { name: 'Owner one' } }]);
      // Parent to child: the inbound edge is to-many, so the embed is an array.
      const toMany = await db.from('sdk_compat_owner').select('id,sdk_compat_item(id)').eq('id', 'o1');
      expect(toMany.error).toBeNull();
      expect((toMany.data as Array<{ sdk_compat_item: Array<{ id: string }> }>)[0].sdk_compat_item.map(r => r.id))
        .toEqual(['i1', 'i2']);
      // A relationship that does not exist is refused, not guessed.
      expect((await db.from(COMPAT_TABLE).select('*, author(*)')).error).not.toBeNull();
    },
  );

  compatCase(
    {
      id: 'data.response.error-shape',
      section: 'Data · response',
      surface: '{ data, error } result envelope',
      status: 'supported',
      note: 'Expected API failures resolve rather than throw. error is { message, status, code }.',
    },
    async () => {
      const result = await db.from('no_such_table').select('*');
      expect(result.data).toBeNull();
      expect(result.error).toMatchObject({ status: 404 });
      expect(typeof result.error?.message).toBe('string');
    },
  );

  compatCase(
    {
      id: 'data.response.select-alias-cast',
      section: 'Data · response',
      surface: "from(t).select('alias:col, col::text')",
      status: 'supported',
      note: 'Renamed columns and casts both compile. A cast target must be a bare lowercase type name with an optional array marker, so it cannot smuggle SQL.',
    },
    async () => {
      const aliased = await db.from(COMPAT_TABLE).select('name:label');
      expect(aliased.error).toBeNull();
      expect(Object.keys((aliased.data ?? [])[0] ?? {})).toContain('name');
      const cast = await db.from(COMPAT_TABLE).select('id,qty::text').eq('id', 'i1');
      expect(cast.error).toBeNull();
      expect(cast.data).toEqual([{ id: 'i1', qty: '10' }]);
      // The cast target is restricted to a bare type name.
      expect((await db.from(COMPAT_TABLE).select('qty::text)); DROP TABLE x --')).error).not.toBeNull();
    },
  );

  compatCase(
    {
      id: 'data.response.select-projection',
      section: 'Data · response',
      surface: "from(t).select('id,label')",
      status: 'supported',
      note: 'Column lists are validated against the table and compiled into the SELECT list.',
    },
    async () => {
      const result = await db.from(COMPAT_TABLE).select('id,label').eq('id', 'i1');
      expect(result.data).toEqual([{ id: 'i1', label: 'alpha' }]);
    },
  );
});

// ── Auth ─────────────────────────────────────────────────────────────────────

describe('Auth', () => {
  // `client.auth` is Better Auth's own client, not a supabase-js port. Each
  // supabase-js auth call gets a row anyway: it is the migration table. The
  // row asserts that the supabase-js call does not exist (Better Auth's client
  // turns any name into a request, so it answers the server's 404 rather than
  // "is not a function"), then exercises the Better Auth call the note names
  // against the real server, so the note cannot point at something broken.

  compatCase(
    {
      id: 'auth.better-auth',
      section: 'Auth',
      surface: 'auth.<any Better Auth client method>',
      status: 'supported',
      note: "client.auth is Better Auth's client, typed with every plugin the server mounts (anonymous, email OTP, magic link, phone number, two-factor, organization, generic OAuth, JWT, passkey, SSO, API keys). Method names, parameters and the { data, error } results are Better Auth's, so its documentation applies as written; the SDK stores the session it returns, which is what from(), storage and realtime then send.",
    },
    async () => {
      const { client } = await disposableClient('better-auth');
      const sessions = await client.auth.listSessions();
      expect(sessions.error).toBeNull();
      expect(sessions.data).toHaveLength(1);
      expect((await client.auth.revokeOtherSessions()).error).toBeNull();
      const { data } = await client.auth.organization.list();
      expect(Array.isArray(data)).toBe(true);
    },
  );

  compatCase(
    {
      id: 'auth.admin',
      section: 'Auth',
      surface: 'auth.admin.*',
      status: 'partial',
      note: 'User administration, MFA factor administration (admin.mfa.listFactors / deleteFactor) and generateLink, only with a secret project API key. This is Motherbase\'s API, shaped like supabase-js, not Better Auth\'s admin plugin. Narrower than the supabase service role, which also opens SQL and DDL. generateLink covers signup, invite, magiclink and recovery; recovery is code-based here, so it returns email_otp and no action_link, and email_change_* is refused.',
    },
    async () => {
      const admin = db.auth.admin;
      for (const method of ['listUsers', 'getUserById', 'createUser', 'updateUserById', 'deleteUser', 'signOut', 'inviteUserByEmail', 'generateLink']) {
        expect(typeof (admin as unknown as Record<string, unknown>)[method]).toBe('function');
      }
      expect(typeof admin.mfa.listFactors).toBe('function');
      expect(typeof admin.mfa.deleteFactor).toBe('function');
      // db holds a user session, not a secret key, so the server refuses it.
      const denied = await admin.listUsers();
      expect(denied.error).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    },
  );

  compatCase(
    {
      id: 'auth.deleteUser',
      section: 'Auth',
      surface: 'auth.deleteUser()',
      status: 'partial',
      note: "Better Auth's deleteUser: self-service, which supabase-js only offers to an admin. It takes the password (or a fresh session), and clears the local session once the account is gone.",
    },
    async () => {
      const { client } = await disposableClient('delete');
      expect((await client.auth.deleteUser({ password: 'compat-password-1' })).error).toBeNull();
      expect(await client.hydrate()).toBeNull();
    },
  );

  compatCase(
    {
      id: 'auth.exchangeCodeForSession',
      section: 'Auth',
      surface: 'auth.exchangeCodeForSession(code) / getSessionFromUrl(href?)',
      status: 'supported',
      note: "With flowType 'pkce' the S256 challenge rides on the callback URL and the redirect returns ?code=, exchanged once against the verifier this browser kept (automatically on load, as detectSessionInUrl does). The implicit flow remains the default: the token comes back in the fragment and getSessionFromUrl reads it and strips it from the URL.",
    },
    async () => {
      // No verifier in this client: an honest error, not a thrown one.
      const exchanged = await db.auth.exchangeCodeForSession('not-a-code');
      expect(exchanged.error?.message).toMatch(/No PKCE code verifier/);
      // Nothing to read is not an error: apps call this on every page load.
      expect(await db.auth.getSessionFromUrl('https://app.example.com/callback')).toEqual({ data: null, error: null });
      const fromUrl = await createClient(harness.baseUrl).auth.getSessionFromUrl(`https://app.example.com/callback#access_token=${encodeURIComponent(harness.token)}`);
      expect(fromUrl.data?.user.email).toBe(harness.user.email);
    },
  );

  compatCase(
    {
      id: 'auth.getSession',
      section: 'Auth',
      surface: 'auth.getSession()',
      status: 'partial',
      note: "Better Auth's getSession: it asks the server, so it is the verified read, and returns { session, user } with Better Auth's session row rather than a token pair. A session the server no longer knows is cleared locally. The stored session without a network call is client.hydrate().",
    },
    async () => {
      const client = await authedClient();
      const { data, error } = await client.auth.getSession();
      expect(error).toBeNull();
      expect(data?.user.email).toBe(harness.user.email);
      // The body names the bare token; the stored bearer stays the signed one.
      expect(harness.token.startsWith(`${data?.session.token}.`)).toBe(true);
      expect((await client.hydrate())?.accessToken).toBe(harness.token);
    },
  );

  compatCase(
    {
      id: 'auth.getUser',
      section: 'Auth',
      surface: 'auth.getUser()',
      status: 'unsupported',
      note: 'Use auth.getSession(), which asks the server and returns the user with the session.',
    },
    async () => {
      const client = await authedClient();
      await expectNoSuchMethod(client, 'getUser');
      expect((await client.auth.getSession()).data?.user.email).toBe(harness.user.email);
    },
  );

  compatCase(
    {
      id: 'auth.identities',
      section: 'Auth',
      surface: 'auth.getUserIdentities() / linkIdentity() / unlinkIdentity()',
      status: 'unsupported',
      note: 'Use auth.listAccounts(), auth.linkSocial({ provider, callbackURL }) and auth.unlinkAccount({ providerId }). A password account lists its credential account.',
    },
    async () => {
      const client = await authedClient();
      await expectNoSuchMethod(client, 'getUserIdentities');
      const { data, error } = await client.auth.listAccounts();
      expect(error).toBeNull();
      expect(data?.map(account => account.providerId)).toContain('credential');
    },
  );

  compatCase(
    {
      id: 'auth.mfa',
      section: 'Auth',
      surface: 'auth.mfa.*',
      status: 'unsupported',
      note: 'Use auth.twoFactor: enable({ password }) returns the TOTP URI and backup codes, verifyTotp / verifyOtp / verifyBackupCode finish a sign-in that answered twoFactorRedirect, disable({ password }) turns it off. The aal the server stamps on a session is on auth.getSession().',
    },
    async () => {
      const client = await authedClient();
      await expectNoSuchMethod(client, 'mfa');
      // The fixture user has never enrolled: there is no URI to read.
      expect((await client.auth.twoFactor.getTotpUri({ password: harness.user.password })).error).not.toBeNull();
    },
  );

  compatCase(
    {
      id: 'auth.onAuthStateChange',
      section: 'Auth',
      surface: 'auth.onAuthStateChange(cb)',
      status: 'supported',
      note: 'Fires INITIAL_SESSION once on subscribe, as supabase-js does, so an app that clears its loading flag on that event also clears it for a signed-out visitor. Then SIGNED_IN, USER_UPDATED, MFA_CHALLENGE_VERIFIED and SIGNED_OUT as the Better Auth calls change the session. There is no TOKEN_REFRESHED: Better Auth sessions are not rotated. Returns { data: { subscription } }.',
    },
    async () => {
      const email = harness.trackEmail(`sdk-compat-events-${Date.now()}@test.local`);
      const client = createClient(harness.baseUrl);
      const events: string[] = [];
      const { data } = client.auth.onAuthStateChange(event => events.push(event));
      expect((await client.auth.signUp.email({ email, password: 'compat-password-1', name: email })).error).toBeNull();
      await client.auth.signOut();
      data.subscription.unsubscribe();
      expect(events).toEqual(['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT']);
    },
  );

  compatCase(
    {
      id: 'auth.refreshSession',
      section: 'Auth',
      surface: 'auth.refreshSession() / startAutoRefresh()',
      status: 'unsupported',
      note: 'Better Auth sessions have no refresh token to rotate. auth.getSession() revalidates, and the client already does so on a 401.',
    },
    async () => {
      const client = await authedClient();
      await expectNoSuchMethod(client, 'refreshSession');
      expect((await client.auth.getSession()).error).toBeNull();
      expect((await client.hydrate())?.accessToken).toBe(harness.token);
    },
  );

  compatCase(
    {
      id: 'auth.resetPassword',
      section: 'Auth',
      surface: 'auth.resetPasswordForEmail(email)',
      status: 'unsupported',
      note: 'Use auth.emailOtp.requestPasswordReset({ email }), then auth.emailOtp.resetPassword({ email, otp, password }): the reset is completed with a one time code rather than a redirect link.',
    },
    async () => {
      const email = harness.trackEmail(`sdk-compat-reset-${Date.now()}@test.local`);
      const client = createClient(harness.baseUrl);
      await client.auth.signUp.email({ email, password: 'compat-password-1', name: email });
      await client.auth.signOut();
      await expectNoSuchMethod(client, 'resetPasswordForEmail');

      expect((await client.auth.emailOtp.requestPasswordReset({ email })).error).toBeNull();
      const otp = harness.otps.get(email);
      expect(otp).toBeTruthy();
      expect((await client.auth.emailOtp.resetPassword({ email, otp: otp!, password: 'compat-password-2' })).error).toBeNull();
      expect((await client.auth.signIn.email({ email, password: 'compat-password-2' })).error).toBeNull();
    },
  );

  compatCase(
    {
      id: 'auth.session-shape',
      section: 'Auth',
      surface: 'session.access_token / user.user_metadata',
      status: 'partial',
      note: "The session the SDK stores (client.hydrate(), onAuthStateChange) carries the supabase-js spellings alongside the native ones: access_token, refresh_token (always null), token_type, and on the user aud, role, created_at, email_confirmed_at, phone, identities and user_metadata holding the profile fields. app_metadata is {} rather than a guessed provider, and expires_at is absent. Better Auth's own responses keep its native shape.",
    },
    async () => {
      const client = await authedClient();
      await client.auth.getSession();
      const session = (await client.hydrate())!;
      expect(session.access_token).toBe(session.accessToken);
      expect(session.token_type).toBe('bearer');
      expect(session.refresh_token).toBeNull();
      expect(session.user.aud).toBe('authenticated');
      expect(session.user.user_metadata).toBeTruthy();
      expect(session.user.app_metadata).toEqual({});
      expect(session.expires_at).toBeUndefined();
    },
  );

  compatCase(
    {
      id: 'auth.getClaims',
      section: 'Auth',
      surface: 'auth.getClaims()',
      status: 'unsupported',
      note: "Use auth.token(): a Better Auth session token is an opaque bearer, so the jwt plugin mints a JWT for the session. Verify it server side against /api/auth/jwks.",
    },
    async () => {
      const client = await authedClient();
      await expectNoSuchMethod(client, 'getClaims');
      const { data, error } = await client.auth.token();
      expect(error).toBeNull();
      expect(data?.token.split('.')).toHaveLength(3);
    },
  );

  compatCase(
    {
      id: 'auth.setSession',
      section: 'Auth',
      surface: 'auth.setSession({ access_token, refresh_token })',
      status: 'unsupported',
      note: 'A session token from elsewhere is adopted through the storage adapter the client is created with, or through auth.getSessionFromUrl() on an OAuth return.',
    },
    async () => {
      const client = createClient(harness.baseUrl);
      await expectNoSuchMethod(client, 'setSession');
    },
  );

  compatCase(
    {
      id: 'auth.signInWithIdToken',
      section: 'Auth',
      surface: 'auth.signInWithIdToken({ provider, token })',
      status: 'unsupported',
      note: 'Use auth.signIn.social({ provider, idToken: { token } }), for Sign in with Apple and Google One Tap from a native app. The provider must be configured on the backend.',
    },
    async () => {
      const client = createClient(harness.baseUrl);
      await expectNoSuchMethod(client, 'signInWithIdToken');
      const result = await client.auth.signIn.social({ provider: 'google', idToken: { token: 'not-a-real-id-token' } });
      expect(result.error).not.toBeNull();
      expect(await client.hydrate()).toBeNull();
    },
  );

  compatCase(
    {
      id: 'auth.signInWithOAuth',
      section: 'Auth',
      surface: 'auth.signInWithOAuth({ provider, options })',
      status: 'unsupported',
      note: "Use auth.signIn.social({ provider, callbackURL }). In a browser it navigates to the server's start route, which keeps the OAuth state cookie first-party; disableRedirect: true returns the URL instead. The redirect back is completed by getSessionFromUrl(), on load by default.",
    },
    async () => {
      const client = createClient(harness.baseUrl);
      await expectNoSuchMethod(client, 'signInWithOAuth');
      const result = await client.auth.signIn.social({ provider: 'google', disableRedirect: true, scopes: ['email', 'profile'] });
      expect(result.error).toBeNull();
      expect(result.data?.url).toContain('accounts.google.com');
    },
  );

  compatCase(
    {
      id: 'auth.signInWithOtp',
      section: 'Auth',
      surface: 'auth.signInWithOtp({ email | phone }) then auth.verifyOtp({ token })',
      status: 'unsupported',
      note: "Use auth.emailOtp.sendVerificationOtp({ email, type: 'sign-in' }) then auth.signIn.emailOtp({ email, otp }); by SMS, auth.phoneNumber.sendOtp and auth.phoneNumber.verify, when the phone-number plugin is on with a sender configured. Magic links are auth.signIn.magicLink.",
    },
    async () => {
      const email = harness.trackEmail(`sdk-compat-otp-${Date.now()}@test.local`);
      const client = createClient(harness.baseUrl);
      await expectNoSuchMethod(client, 'signInWithOtp');
      expect((await client.auth.emailOtp.sendVerificationOtp({ email, type: 'sign-in' })).error).toBeNull();
      const otp = harness.otps.get(email);
      expect(otp).toBeTruthy();
      expect((await client.auth.signIn.emailOtp({ email, otp: otp! })).error).toBeNull();
      expect((await client.hydrate())?.accessToken).toBeTruthy();
    },
  );

  compatCase(
    {
      id: 'auth.signInWithPassword',
      section: 'Auth',
      surface: 'auth.signInWithPassword({ email, password })',
      status: 'unsupported',
      note: 'Use auth.signIn.email({ email, password }). The session is stored through the configured storage adapter and SIGNED_IN fires; with two-factor on, the answer is { twoFactorRedirect: true } and no session until auth.twoFactor verifies a code.',
    },
    async () => {
      const client = createClient(harness.baseUrl);
      await expectNoSuchMethod(client, 'signInWithPassword');
      const result = await client.auth.signIn.email({ email: harness.user.email, password: harness.user.password });
      expect(result.error).toBeNull();
      expect((await client.hydrate())?.accessToken).toBe(result.data?.token);
      expect((await client.auth.signIn.email({ email: harness.user.email, password: 'wrong' })).error).not.toBeNull();
    },
  );

  compatCase(
    {
      id: 'auth.signInWithSSO',
      section: 'Auth',
      surface: 'auth.signInWithSSO({ domain })',
      status: 'unsupported',
      note: 'Use auth.signIn.sso({ email, callbackURL }), or name the provider by domain, providerId or organizationSlug instead of email. The project needs the SSO plugin on and a provider registered; providers are managed with auth.sso.*.',
    },
    async () => {
      await expectNoSuchMethod(db, 'signInWithSSO');
      // No provider is registered for this domain, so the server refuses it.
      const unknownDomain = await db.auth.signIn.sso({ domain: 'no-such-sso-provider.test', callbackURL: 'https://app.example.com/' });
      expect(unknownDomain.error).not.toBeNull();
    },
  );

  compatCase(
    {
      id: 'auth.signOut',
      section: 'Auth',
      surface: 'auth.signOut()',
      status: 'supported',
      note: "Better Auth's signOut: revokes the server session and clears the local one. Other devices are auth.revokeOtherSessions(), every device auth.revokeSessions().",
    },
    async () => {
      const { client } = await disposableClient('signout');
      expect((await client.auth.signOut()).error).toBeNull();
      expect(await client.hydrate()).toBeNull();
    },
  );

  compatCase(
    {
      id: 'auth.signUp',
      section: 'Auth',
      surface: 'auth.signUp({ email, password })',
      status: 'unsupported',
      note: 'Use auth.signUp.email({ email, password, name }). It answers { token, user }, with a null token while the project requires email verification first.',
    },
    async () => {
      const email = harness.trackEmail(`sdk-compat-signup-${Date.now()}@test.local`);
      const client = createClient(harness.baseUrl);
      await expectNoSuchMethod(client, 'signUp');
      const result = await client.auth.signUp.email({ email, password: 'compat-password-1', name: email });
      expect(result.error).toBeNull();
      expect(result.data?.user.email).toBe(email);
      expect(result.data?.token).toBeTruthy();
    },
  );

  compatCase(
    {
      id: 'auth.updateUser',
      section: 'Auth',
      surface: 'auth.updateUser({ data, email, password })',
      status: 'partial',
      note: "Better Auth's updateUser takes the profile fields flat ({ name, image, ...additional fields }), not under data. A password is auth.changePassword({ currentPassword, newPassword }); an anonymous user's first email, a first password, or a password replaced with the nonce from auth.reauthenticate() is auth.updateUserCredentials().",
    },
    async () => {
      const client = await authedClient();
      expect((await client.auth.updateUser({ name: harness.user.email })).error).toBeNull();
      const blind = await client.auth.updateUserCredentials({ password: 'another-password-1' });
      expect(blind.error?.message).toContain('reauthenticate()');
    },
  );
});

// ── Storage ──────────────────────────────────────────────────────────────────

describe('Storage', () => {
  compatCase(
    {
      id: 'storage.bucket-admin',
      section: 'Storage',
      surface: 'storage.createBucket/getBucket/listBuckets/updateBucket/emptyBucket/deleteBucket',
      status: 'partial',
      note: 'All six are on the client and every one needs a secret project API key, which is the same rule Supabase applies to bucket administration. With a publishable key they resolve with a 401 rather than a partial answer. deleteBucket refuses a bucket that still holds objects unless force is passed, so one unqualified call cannot destroy the files in it.',
    },
    async () => {
      // The shared client holds a session, not a secret key: the gate must hold.
      const denied = await db.storage.listBuckets();
      expect(denied.data).toBeNull();
      expect(denied.error).toMatchObject({ status: 401 });
      for (const method of ['createBucket', 'getBucket', 'listBuckets', 'updateBucket', 'emptyBucket', 'deleteBucket']) {
        expect(typeof (db.storage as unknown as Record<string, unknown>)[method]).toBe('function');
      }
    },
  );

  compatCase(
    {
      id: 'storage.createSignedUrl',
      section: 'Storage',
      surface: 'storage.from(b).createSignedUrl(path, expiresIn)',
      status: 'partial',
      note: 'expiresIn is read, in seconds, and validated from 1 second to 7 days (the AWS SigV4 ceiling); a longer lifetime is refused rather than quietly clamped. It resolves to { signedUrl, expiresAt }, and expiresAt is null when nothing actually expires: a public object URL is permanent, and a private object on the local driver resolves to the authenticated streaming endpoint, which is bound to the session rather than to a clock.',
    },
    async () => {
      const client = await authedClient();
      const upload = await client.storage.from('compat').upload('signed.txt', new Blob(['s']));
      const signed = await client.storage.from('compat').createSignedUrl('signed.txt', 60);
      expect(signed.error).toBeNull();
      expect(signed.data?.signedUrl).toContain(upload.data!.id);
      expect(signed.data).toHaveProperty('expiresAt');

      // The note above claims the lifetime is read rather than ignored, so it
      // has to be provable: a value past the ceiling is refused. The parameter
      // was once literally named `_expiresIn`, and this row said so long after
      // it had been threaded through to the driver.
      const tooLong = await client.storage.from('compat').createSignedUrl('signed.txt', 60 * 60 * 24 * 30);
      expect(tooLong.error?.message).toMatch(/between 1 and/);
    },
  );

  compatCase(
    {
      id: 'storage.createSignedUrls',
      section: 'Storage',
      surface: 'storage.from(b).createSignedUrls(paths, expiresIn)',
      status: 'supported',
      note: 'Signs each key and reports per entry, so a missing object yields one entry carrying an error instead of failing the batch. There is no batch endpoint behind it: it is one request per key.',
    },
    async () => {
      const client = await authedClient();
      await client.storage.from('compat').upload('batch-a.txt', new Blob(['a']));
      const signed = await client.storage.from('compat').createSignedUrls(['batch-a.txt', 'no-such-object.txt']);
      expect(signed.error).toBeNull();
      expect(signed.data![0].signedUrl).toBeTruthy();
      expect(signed.data![1].signedUrl).toBeNull();
      expect(signed.data![1].error).toBeTruthy();
    },
  );

  compatCase(
    {
      id: 'storage.download',
      section: 'Storage',
      surface: 'storage.from(b).download(path)',
      status: 'supported',
      note: 'Resolves a Blob, addressed by the key the object was uploaded under. A file id is still accepted.',
    },
    async () => {
      const client = await authedClient();
      const upload = await client.storage.from('compat').upload('down/nested.txt', new Blob(['payload']));
      expect(await (await client.storage.from('compat').download('down/nested.txt')).data?.text()).toBe('payload');
      // Both addressing modes reach the same object.
      expect(await (await client.storage.from('compat').download(upload.data!.id)).data?.text()).toBe('payload');
    },
  );

  compatCase(
    {
      id: 'storage.getPublicUrl',
      section: 'Storage',
      surface: 'storage.from(b).getPublicUrl(path)',
      status: 'supported',
      note: 'Synchronous, returns { data: { publicUrl } } built from the client base URL.',
    },
    () => {
      const url = db.storage.from('compat').getPublicUrl('abc').data.publicUrl;
      expect(url).toBe(`${harness.baseUrl}/api/storage/compat/files/abc`);
    },
  );

  compatCase(
    {
      id: 'storage.list',
      section: 'Storage',
      surface: 'storage.from(b).list(prefix, options)',
      status: 'supported',
      note: 'Lists objects under a prefix in the Supabase response shape (name, id, created_at, updated_at, metadata), with limit, offset, search and sortBy. Keys come back relative to the bucket.',
    },
    async () => {
      const client = await authedClient();
      await client.storage.from('compat').upload('listing/a.txt', new Blob(['a']), { upsert: true });
      await client.storage.from('compat').upload('listing/b.txt', new Blob(['b']), { upsert: true });

      const result = await client.storage.from('compat').list('listing');
      expect(result.error).toBeNull();
      expect(result.data?.map(o => o.name).sort()).toEqual(['listing/a.txt', 'listing/b.txt']);
      expect(result.data?.[0]).toMatchObject({ metadata: expect.objectContaining({ size: 1 }) });

      // A prefix that matches nothing is an empty list, not an error.
      expect((await client.storage.from('compat').list('nothing-here')).data).toEqual([]);
    },
  );

  compatCase(
    {
      id: 'storage.move-copy',
      section: 'Storage',
      surface: 'storage.from(b).move(from, to) / .copy(from, to)',
      status: 'supported',
      note: 'Both work within one bucket. The bytes stream through the upload path, so bucket quota, the size guard and the mime allowlist apply to a copy exactly as to a fresh upload. move deletes the source only once the copy has landed.',
    },
    async () => {
      const client = await authedClient();
      const bucket = client.storage.from('compat');
      await bucket.upload('move-src.txt', new Blob(['payload']));

      const copied = await bucket.copy('move-src.txt', 'move-copy.txt');
      expect(copied.error).toBeNull();
      expect((await bucket.exists('move-src.txt')).data).toBe(true);
      expect((await bucket.exists('move-copy.txt')).data).toBe(true);

      const moved = await bucket.move('move-copy.txt', 'move-dst.txt');
      expect(moved.error).toBeNull();
      expect((await bucket.exists('move-copy.txt')).data).toBe(false);
      expect((await bucket.exists('move-dst.txt')).data).toBe(true);
      expect(await (await bucket.download('move-dst.txt')).data!.text()).toBe('payload');
    },
  );

  compatCase(
    {
      id: 'storage.info-exists',
      section: 'Storage',
      surface: 'storage.from(b).info(path) / .exists(path)',
      status: 'supported',
      note: "info returns the object's metadata without its body, in the supabase-js shape. exists reports false only for a 404: an authorization failure is reported as an error, because treating one as absence is how a UI offers to create something that is already there.",
    },
    async () => {
      const client = await authedClient();
      const bucket = client.storage.from('compat');
      await bucket.upload('info.txt', new Blob(['1234']));

      const info = await bucket.info('info.txt');
      expect(info.error).toBeNull();
      expect(info.data).toMatchObject({ name: 'info.txt', bucket_id: 'compat', size: 4 });

      expect((await bucket.exists('info.txt')).data).toBe(true);
      expect((await bucket.exists('definitely-not-here.txt')).data).toBe(false);
    },
  );

  compatCase(
    {
      id: 'storage.update',
      section: 'Storage',
      surface: 'storage.from(b).update(path, file)',
      status: 'supported',
      note: 'upload with upsert forced on, exactly as in supabase-js.',
    },
    async () => {
      const client = await authedClient();
      const bucket = client.storage.from('compat');
      await bucket.upload('update.txt', new Blob(['first']));
      const updated = await bucket.update('update.txt', new Blob(['second']));
      expect(updated.error).toBeNull();
      expect(await (await bucket.download('update.txt')).data!.text()).toBe('second');
    },
  );

  compatCase(
    {
      id: 'storage.signed-upload',
      section: 'Storage',
      surface: 'storage.from(b).createSignedUploadUrl(path) / .uploadToSignedUrl(path, token, file)',
      status: 'partial',
      note: "Both exist and land the object at the key you asked for, but createSignedUploadUrl needs the byte size and content type up front: the upload is reserved against the bucket quota and the signature is bound to that exact length, which is what stops a signed URL becoming an unbounded write. Requires the S3 driver; the local driver has no presigned uploads.",
    },
    async () => {
      const client = await authedClient();
      const bucket = client.storage.from('compat');
      const body = new Blob(['signed-upload']);
      const signed = await bucket.createSignedUploadUrl('signed-up.txt', { size: body.size, contentType: 'text/plain' });
      if (signed.error) {
        // Local driver: no presigned uploads, and that is the documented limit.
        expect(signed.data).toBeNull();
        return;
      }
      const uploaded = await bucket.uploadToSignedUrl('signed-up.txt', signed.data!.token, body);
      expect(uploaded.error).toBeNull();
      expect((await bucket.exists('signed-up.txt')).data).toBe(true);
    },
  );

  compatCase(
    {
      id: 'storage.remove',
      section: 'Storage',
      surface: 'storage.from(b).remove([path])',
      status: 'supported',
      note: 'Addressed by the key the object was uploaded under, as in supabase-js, and reported per entry. A bare file id still resolves, exactly as it does for download.',
    },
    async () => {
      const client = await authedClient();
      const upload = await client.storage.from('compat').upload('gone.txt', new Blob(['x']));
      const removed = await client.storage.from('compat').remove([upload.data!.path]);
      expect(removed).toEqual({ data: [{ deleted: true }], error: null });

      // This row read "the entries are file ids and not bucket paths" while the
      // assertion above already removed by path. Both forms are now asserted, so
      // the sentence cannot drift away from them again.
      const byId = await client.storage.from('compat').upload('gone-by-id.txt', new Blob(['x']));
      const removedById = await client.storage.from('compat').remove([byId.data!.id]);
      expect(removedById).toEqual({ data: [{ deleted: true }], error: null });
    },
  );

  compatCase(
    {
      id: 'storage.transform',
      section: 'Storage',
      surface: 'storage.from(b).download(path, { transform })',
      status: 'supported',
      note: 'Also getPublicUrl and createSignedUrl with { transform }, served by /storage/v1/render/image with Supabase limits. Without format, WebP is negotiated from Accept.',
    },
    async () => {
      const client = await authedClient();
      const image = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#000' } }).png().toBuffer();
      const upload = await client.storage.from('compat').upload('img.png', new Blob([image], { type: 'image/png' }));
      const download = await client.storage
        .from('compat')
        .download(upload.data!.path, { transform: { width: 10, format: 'origin' } });
      const meta = await sharp(Buffer.from(await download.data!.arrayBuffer())).metadata();
      expect([meta.width, meta.format]).toEqual([10, 'png']);
    },
  );

  compatCase(
    {
      id: 'storage.upload',
      section: 'Storage',
      surface: 'storage.from(b).upload(path, file, options)',
      status: 'supported',
      note: 'The key is the one you passed. avatars/{uid}/pic.png style paths round trip through upload, download, remove and the signed URL. The file id keeps working everywhere a path does.',
    },
    async () => {
      const client = await authedClient();
      const result = await client.storage.from('compat').upload('nested/key.txt', new Blob(['body']), {
        visibility: 'private',
      });
      expect(result.error).toBeNull();
      expect(result.data?.path).toBe('nested/key.txt');
      expect(result.data?.fullPath).toBe('compat/nested/key.txt');
      // The id is still returned, because callers written before path
      // addressing stored it.
      expect(result.data?.id).toMatch(/^[0-9a-f-]{36}$/);
      // A key that could climb out of the bucket is refused, not sanitised.
      expect((await client.storage.from('compat').upload('../escape.txt', new Blob(['x']))).error).not.toBeNull();
    },
  );

  compatCase(
    {
      id: 'storage.upload.options',
      section: 'Storage',
      surface: "storage.from(b).upload(path, file, { upsert, contentType })",
      status: 'partial',
      note: "upsert works: without it a second write to the same key is a 409, with it the object is replaced. contentType overrides what the file itself declares. supabase-js' cacheControl is not part of UploadOptions, so a ported call naming it is a type error rather than a silently dropped option: cache headers are decided by the driver and, for a transform, by the render endpoint.",
    },
    async () => {
      const client = await authedClient();
      const first = await client.storage.from('compat').upload('same.txt', new Blob(['1']), { upsert: true });
      expect(first.error).toBeNull();

      // Refusing by default is the point: silently replacing an object someone
      // else wrote is not something to infer from an ordinary upload.
      const clash = await client.storage.from('compat').upload('same.txt', new Blob(['2']));
      expect(clash.error).not.toBeNull();

      const replaced = await client.storage.from('compat').upload('same.txt', new Blob(['2']), { upsert: true });
      expect(replaced.error).toBeNull();
      expect(await (await client.storage.from('compat').download('same.txt')).data?.text()).toBe('2');

      // The other option the row names. It used to name `cacheControl`, which
      // UploadOptions does not declare, so nothing here could have exercised it.
      const typed = await client.storage
        .from('compat')
        .upload('typed.csv', new Blob(['a,b']), { contentType: 'text/csv' });
      expect(typed.error).toBeNull();
    },
  );
});

// ── Realtime ─────────────────────────────────────────────────────────────────

describe('Realtime', () => {
  compatCase(
    {
      id: 'realtime.broadcast',
      section: 'Realtime',
      surface: "channel(n).on('broadcast', { event }, cb) and channel.send(...)",
      status: 'supported',
      note: 'Routed by topic. config.broadcast.self and config.broadcast.ack are both honoured.',
    },
    async () => {
      const { client, socket } = realtimeClient();
      const got: unknown[] = [];
      const channel = client
        .channel('room:b', { config: { broadcast: { self: true, ack: true } } })
        .on('broadcast', { event: 'ping' }, m => got.push(m))
        .subscribe();
      await settle();
      expect(await channel.send({ type: 'broadcast', event: 'ping', payload: { a: 1 } })).toBe('ok');
      socket.deliver(REALTIME_TOPIC_EVENTS.message, {
        topic: 'room:b',
        type: 'broadcast',
        event: 'ping',
        payload: { a: 1 },
      });
      expect(got).toEqual([{ type: 'broadcast', event: 'ping', payload: { a: 1 } }]);
    },
  );

  compatCase(
    {
      id: 'realtime.channel.private',
      section: 'Realtime',
      surface: "channel(n, { config: { private: true } })",
      status: 'supported',
      note: 'The flag is sent in the join payload; the server then checks the RLS policies on realtime.messages (SELECT to receive, INSERT to send or track).',
    },
    async () => {
      const { client, socket } = realtimeClient();
      client.channel('room:p', { config: { private: true } } as never).on('broadcast', { event: 'x' }, () => {}).subscribe();
      await settle();
      const join = socket.emitted.find(e => e.event === REALTIME_TOPIC_EVENTS.join);
      expect(JSON.stringify(join?.args[0])).toContain('"private":true');
    },
  );

  compatCase(
    {
      id: 'realtime.channel.unknown-event',
      section: 'Realtime',
      surface: "channel(n).on('system', ...)",
      status: 'unsupported',
      note: 'Only broadcast, presence and postgres_changes are accepted. Anything else throws immediately.',
    },
    () => {
      const { client } = realtimeClient();
      expect(() => client.channel('room:s').on('system' as never, {} as never, () => {})).toThrow(/Unsupported channel event type/);
    },
  );

  compatCase(
    {
      id: 'realtime.postgres_changes',
      section: 'Realtime',
      surface: "channel(n).on('postgres_changes', { event, schema, table, filter }, cb).subscribe()",
      status: 'supported',
      note: 'INSERT, UPDATE, DELETE and * are delivered with the supabase payload shape. Server side the stream is RLS filtered.',
    },
    async () => {
      const { client, socket } = realtimeClient();
      const got: Array<{ eventType: string }> = [];
      client
        .channel('room:pg')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: 'room_id=eq.42' }, p =>
          got.push(p),
        )
        .subscribe();
      await settle();
      const join = socket.emitted.find(e => e.event === REALTIME_TOPIC_EVENTS.join);
      expect(join?.args[0]).toMatchObject({
        topic: 'room:pg',
        config: {
          postgres_changes: [{ event: '*', schema: 'public', table: 'messages', filter: 'room_id=eq.42' }],
        },
      });
      socket.deliver(REALTIME_TOPIC_EVENTS.message, {
        topic: 'room:pg',
        type: 'postgres_changes',
        event: 'INSERT',
        payload: { schema: 'public', table: 'messages', eventType: 'INSERT', new: { id: 1 }, old: {}, commit_timestamp: 'now' },
      });
      expect(got.map(p => p.eventType)).toEqual(['INSERT']);
    },
  );

  compatCase(
    {
      id: 'realtime.presence',
      section: 'Realtime',
      surface: "channel(n).on('presence', ...) with track/untrack/presenceState",
      status: 'supported',
      note: 'The server sends full state and the client diffs it into sync, join and leave, keyed by config.presence.key.',
    },
    async () => {
      const { client, socket } = realtimeClient();
      const events: string[] = [];
      const channel = client
        .channel('room:pr', { config: { presence: { key: 'me' } } })
        .on('presence', { event: 'sync' }, () => events.push('sync'))
        .on('presence', { event: 'join' }, () => events.push('join'))
        .subscribe();
      await settle();
      expect(await channel.track({ online: true })).toBe('ok');
      socket.deliver(REALTIME_TOPIC_EVENTS.message, {
        topic: 'room:pr',
        type: 'presence',
        event: 'state',
        payload: { me: [{ presence_ref: 'r1', online: true }] },
      });
      expect(channel.presenceState()).toEqual({ me: [{ presence_ref: 'r1', online: true }] });
      expect(events).toEqual(['join', 'sync']);
    },
  );

  compatCase(
    {
      id: 'realtime.removeChannel',
      section: 'Realtime',
      surface: 'client.removeChannel(channel) / client.removeAllChannels()',
      status: 'supported',
      note: 'Unsubscribes and drops the channel, resolving to "ok".',
    },
    async () => {
      const { client, socket } = realtimeClient();
      const channel = client.channel('room:r').on('broadcast', { event: 'x' }, () => {}).subscribe();
      await settle();
      expect(await client.removeChannel(channel)).toBe('ok');
      expect(socket.emitted.some(e => e.event === REALTIME_TOPIC_EVENTS.leave)).toBe(true);
      expect(await client.removeAllChannels()).toBe('ok');
    },
  );

  compatCase(
    {
      id: 'realtime.subscribe.status',
      section: 'Realtime',
      surface: 'channel.subscribe(status => {})',
      status: 'supported',
      note: 'Reports SUBSCRIBED, TIMED_OUT, CLOSED and CHANNEL_ERROR, as supabase-js does.',
    },
    async () => {
      const { client } = realtimeClient();
      let status = '';
      client.channel('room:st').on('broadcast', { event: 'x' }, () => {}).subscribe(s => {
        status = s;
      });
      await settle();
      expect(status).toBe('SUBSCRIBED');
    },
  );
});

// ── Edge functions ───────────────────────────────────────────────────────────

describe('Edge functions', () => {
  compatCase(
    {
      id: 'functions.invoke',
      section: 'Edge functions',
      surface: 'functions.invoke(name, { body })',
      status: 'supported',
      note: 'POSTs the JSON body to /api/edge/:name with the current session bearer attached.',
    },
    async () => {
      const client = await authedClient();
      expect(await client.functions.invoke('compat-echo', { body: { value: 42 } })).toEqual({
        data: { echoed: 42 },
        error: null,
      });
    },
  );

  compatCase(
    {
      id: 'functions.invoke.error',
      section: 'Edge functions',
      surface: 'functions.invoke error handling',
      status: 'partial',
      note: 'invoke resolves { data: null, error } rather than throwing, but error is a real FunctionsHttpError (or FunctionsFetchError when the request never reached the server), so an instanceof check ported from supabase-js still works.',
    },
    async () => {
      const client = await authedClient();
      const result = await client.functions.invoke('no-such-function');
      expect(result.data).toBeNull();
      expect(result.error).toMatchObject({ status: 404 });
      // The note claims an instanceof check keeps working, so assert it here:
      // a note nothing pins is how this table starts lying again.
      expect(result.error).toBeInstanceOf(FunctionsHttpError);
    },
  );

  compatCase(
    {
      id: 'functions.invoke.options',
      section: 'Edge functions',
      surface: "functions.invoke(name, { headers, method, region })",
      status: 'partial',
      note: 'method and headers are honoured: the invoke route answers every verb and forwards the request headers to the function, so a function reading req.method sees the one you asked for. region is accepted and ignored, because a self-hosted Motherbase runs its functions in one place.',
    },
    async () => {
      const client = await authedClient();
      const posted = await client.functions.invoke('compat-echo', {
        body: { value: 7 },
        headers: { 'x-compat': '1' },
        region: 'us-east-1',
      });
      expect(posted).toEqual({ data: { echoed: 7 }, error: null });
      // A GET carries no body, so the function sees the verb rather than the payload.
      const got = await client.functions.invoke('compat-echo', { method: 'GET' });
      expect(got.error).toBeNull();
    },
  );
});

// ── Guards on the document itself ────────────────────────────────────────────

describe('Compatibility document', () => {
  it('gives every row a unique, non-empty test id', () => {
    const rows = compatRows();
    expect(rows.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const row of rows) {
      expect(row.id.trim()).not.toBe('');
      expect(row.note.trim()).not.toBe('');
      expect(seen.has(row.id)).toBe(false);
      seen.add(row.id);
    }
  });

  it('keeps the client README pointing at the generated file instead of a hand-written table', () => {
    const readme = readFileSync(CLIENT_README_PATH, 'utf8');
    expect(readme).toContain('./COMPATIBILITY.md');
    expect(readme).toContain('sdk-contract.integration.test.ts');
    // A hand-maintained status table is exactly what this suite replaces.
    expect(readme).not.toMatch(/\|\s*Not supported\s*\|/);
  });
});
