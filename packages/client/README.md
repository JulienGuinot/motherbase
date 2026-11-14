# @motherbase/client

A client SDK for the Motherbase self-hosted backend. The data, storage,
realtime and functions layers are **supabase-js-shaped**: the same entry points
(`createClient`, `.from()`, `.storage`, `.channel()`, `.functions`) and the same
`{ data, error }` result convention.

**Auth is Better Auth, on purpose.** `client.auth` is
[Better Auth](https://www.better-auth.com/docs)'s own client, typed with every
plugin the server mounts, served through this package (you do not install
`better-auth` yourself). Every method in Better Auth's documentation is there
under its own name: `client.auth.signIn.email()`, `client.auth.listSessions()`,
`client.auth.revokeSession()`, `client.auth.twoFactor.enable()`,
`client.auth.organization.create()`, `client.auth.passkey.addPasskey()`… We
chose it over a supabase-js imitation because it exposes more: sessions per
device, organizations and teams, passkeys, SSO, API keys. Porting supabase-js
auth code is a rename, and [`COMPATIBILITY.md`](./COMPATIBILITY.md) names the
Better Auth call for every supabase-js one (`motherbase migrate codemod` lists
them in your code).

**Scope, honestly.** For the **data layer**, this is a package swap: change the
import and the client factory, keep your queries. Every `supabase-js` data call
in the contract suite is either supported or supported with a stated difference,
including relational embedding (`select('*, author(*)')`), `.rpc()`, native
`upsert`, `count`, `csv()`, the full filter set and PostgREST error codes.
Realtime is close, with named gaps (no private channels).

**Storage is path-addressed too**: `upload('avatars/123/pic.png')` then
`download('avatars/123/pic.png')` round trips, `list(prefix)` works, and keys are
traversal-checked. `copy`, `move`, `info`, `exists`, batch signed URLs and
direct-to-storage signed uploads are supported; image transforms are not.
Authorization is ownership plus bucket tokens by default, and real RLS policies on
`storage.files` when the `storage.policies` setting is on. See
[`docs/migrating-from-supabase.md`](https://github.com/JulienGuinot/motherbase/blob/master/docs/migrating-from-supabase.md).

On the server, `createClient(url, secretKey)` also authorizes storage objects as
`service_role`, including objects uploaded by another user. Secret-key
impersonation keeps the permissions of the impersonated caller. Anonymous uploads
require storage policies granting INSERT; they do not require SELECT. An upload
response's `url` can be `null` when the caller cannot read the object.

Uploads accept `Blob`, `ArrayBuffer`, and typed arrays, including Node `Buffer`.
Signed uploads carry a scoped finalization token; keep the entire returned token
when calling `uploadToSignedUrl`. This capability grants finalization, not private
read access. Public URLs use the shared contracts route.

For auth mutations in Node, the SDK supplies the project URL's origin when no
`Origin` header was provided. An explicit `headers: { Origin: 'https://app.example' }`
is preserved and must be trusted by the server. Browser requests retain the
browser's Origin and the server's CSRF checks remain enabled.

Do not plan a migration from the paragraph above. Plan it from
[`COMPATIBILITY.md`](./COMPATIBILITY.md), which is generated from contract tests
and is exhaustive, per method, with the exact difference for every partial row.

**Write responses (Supabase semantics).** Native and compatibility clients,
including SSR clients, return `data: null` after a successful write unless you
chain `.select()`. For a public contact form, grant INSERT and create an INSERT
policy; no SELECT policy is needed. Requesting rows also requires SELECT access.

```ts
// Write only: no SELECT access required.
const { error } = await client.from('contacts').insert({ email, message });

// Read back the stored row, including generated defaults, if RLS permits it.
const { data } = await client.from('contacts').insert({ email, message }).select().single();
```

Existing Motherbase code that consumed implicit write responses must add
`.select()` to those calls. Raw REST writes default to `Prefer: return=minimal`;
use `Prefer: return=representation` to receive rows. Apply the
`20260924120000_rest_write_capture` server migration before starting the updated
server: internal trigger capture keeps realtime/webhooks transactional without
requiring client read access. It does not enable event delivery for arbitrary
SQL-editor or RPC writes. Motherbase's `transaction()` extension retains its
existing batch response contract.

Transaction callbacks describe writes without awaiting the individual builders.
Awaiting a transaction builder is rejected before any request is sent. The batch
endpoint does not support per-operation preferences or headers: `rollback()`,
`maxAffected()`, upsert conflict preferences, count options and custom headers
are rejected locally instead of being silently ignored. Use a standalone query
for those options.

Multiple `postgres_changes` bindings on one realtime channel require a server
that advertises binding-id support in its join acknowledgement. Older servers
remain usable with one binding per channel; a multi-binding subscription reports
`CHANNEL_ERROR` with upgrade instructions.

**Invalid keys are refused.** A project key that is unknown or revoked now
answers `401 UNAUTHORIZED` even when the project does not require an API key.
Before, it was ignored and the request ran as anonymous. Remove stale keys from
client configuration rather than relying on that fallback.

Typed, isomorphic (browser, Next.js server & client, Expo / React Native), built
on global `fetch`. Its runtime dependencies are Better Auth's client and its
plugins; `socket.io-client` is an optional peer dependency, used only for
realtime.

## Upgrading from 1.x

Only the auth renames fail to compile. Go through the rest by hand:

1. **Upgrade the server first**, with its migrations applied
   (`20260924120000_rest_write_capture` among them). A 2.x client does not check
   the server version.
2. **Auth calls are Better Auth's.** `signInWithPassword` is `signIn.email`,
   `signUp` is `signUp.email` (which requires `name`), `getUser` is gone.
   [`COMPATIBILITY.md`](./COMPATIBILITY.md) has every rename;
   `motherbase migrate codemod` lists the ones in your code.
3. **Authorize on `auth.getSession()`**: it asks the server. `client.hydrate()`
   returns what storage holds, unverified.
4. **Writes resolve `data: null` without `.select()`**, now in the types too: a
   1.x call that read `data` from a bare `insert()` stops compiling.
5. **A stale project key is a 401** (see *Invalid keys are refused* above).

Signed-in users stay signed in: 1.x already stored the server's Better Auth
session token, in the same shape.

On npm 10, `npm install` crashes resolving Better Auth 1.6's optional peers
(`Cannot read properties of null (reading 'edgesOut')`), with or without this
package. Use npm 11+, or `legacy-peer-deps=true` in `.npmrc`.

## Install

```bash
npm i @motherbase/client
# optional, only if you use realtime:
npm i socket.io-client
```

## Quickstart

```ts
import { createClient, localStorageStorage } from '@motherbase/client';

const client = createClient(
  'http://localhost:5001',
  'your-anon-key', // optional; sent as an `apikey` header
  { storage: localStorageStorage() } // omit for in-memory (SSR-safe) sessions
);

await client.hydrate(); // restore a persisted session (optional)

// Auth (Better Auth's client)
await client.auth.signUp.email({ email: 'me@example.com', password: 'secret123', name: 'Me' });
const { data, error } = await client.auth.signIn.email({
  email: 'me@example.com',
  password: 'secret123',
});
const { data: devices } = await client.auth.listSessions();

// Query builder (awaitable, PostgREST-style)
const { data: products } = await client
  .from('products')
  .select('id,name,price')
  .lt('price', 50)
  .order('name', { ascending: false })
  .limit(20);

// Storage. `uploaded.path` is the key you passed, so later download/remove/
// signed-URL calls take the same string.
const { data: uploaded } = await client.storage.from('avatars').upload(`${userId}/me.png`, myBlob, {
  visibility: 'public',
});

// Realtime: postgres_changes, broadcast, presence over one channel (Supabase-shaped)
const room = client
  .channel('room-1', { config: { broadcast: { self: true }, presence: { key: userId } } })
  .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: 'room_id=eq.42' }, p => {
    console.log(p.eventType, p.new, p.old);
  })
  .on('broadcast', { event: 'cursor' }, ({ payload }) => console.log(payload))
  .on('presence', { event: 'sync' }, () => console.log(room.presenceState()))
  .subscribe();

await room.send({ type: 'broadcast', event: 'cursor', payload: { x: 1, y: 2 } });
await room.track({ online_at: Date.now() });

// Edge functions
const { data: result } = await client.functions.invoke('hello', { body: { name: 'Ada' } });
```

Every data/auth/storage call resolves to `{ data, error }` and **never throws**
for expected API errors. `error` is `null` on success, otherwise
`{ message, status?, code? }` (Better Auth's `{ message?, status, statusText }`
for `client.auth`).

The SDK attaches the access token automatically and revalidates it on a 401
(single-flight: concurrent requests share one revalidation). Sessions are Better
Auth bearer sessions, so there is no separate refresh token to rotate: when the
token is no longer valid the SDK clears the session and emits `SIGNED_OUT`.

REST and storage requests carry a short-lived JWT instead, minted in the
background from the session and held in memory only, so the server verifies them
without a database read. Until one is ready, and whenever one is refused, the
session token is sent as before. Auth and edge function calls always send the
session token. `createClient(url, key, { accessTokens: false })` turns this off.

## API surface (cheatsheet)

```ts
// Data. Filters: eq neq gt gte lt lte like ilike likeAllOf likeAnyOf ilikeAllOf
// ilikeAnyOf in is not or filter match textSearch contains containedBy overlaps
// rangeGt rangeGte rangeLt rangeLte rangeAdjacent
client.from(table).select(cols).eq(col, v).in(col, [..]).order(col, { ascending, nullsFirst, referencedTable })
client.from(table).select(cols).limit(n, { referencedTable }).range(from, to).abortSignal(signal)
client.from(table).select(cols).or('a.eq.1,and(b.gt.2,c.is.null)')   // nests, as PostgREST does
client.from(table).select(cols).not(col, 'eq', v).filter(col, 'isdistinct', v)
client.from(table).select(cols).textSearch(col, q, { type: 'websearch', config: 'english' })
client.from(table).select(cols).single() | .maybeSingle() | .returns<T>() | .csv() | .geojson() | .explain()
client.from(table).update(v).eq(..).throwOnError() | .maxAffected(1) | .rollback()
client.from(table).insert(row) | .insert([rowA, rowB], { defaultToNull: false })
client.from(table).upsert(rows, { onConflict, ignoreDuplicates })
client.from(table).update(values).eq(..)         // a filter is required
client.from(table).delete().eq(..)               // a filter is required
// Every call resolves { data, error, count }. `count` is null unless you ask:
// .select('*', { count: 'exact', head: true }).
// Values are quoted for you: .in('name', ['a,b']) is one value, not two.
// Writes return { data: null, error: null } by default, like supabase-js.
// Add .select() to insert/upsert/update/delete to request the written rows.
// Returning rows requires a SELECT policy as well as the write policy.
// An unbounded select is capped by api.rest.maxRows (1000 by default): paginate with .range().
// explain() needs an admin caller; a normal caller gets 403.

// Relational embedding. Compiles to a correlated LATERAL subquery inside the
// same RLS transaction, so embedded rows are policy-filtered too.
client.from('posts').select('id, author(name), comments(id)')     // object / array by FK shape
client.from('posts').select('id, author!inner(name)')             // inner join semantics
client.from('posts').select('id, comments(count)')                // aggregate

// Database functions (typed from the generated Database["public"]["Functions"]).
// Runs in the caller's RLS transaction. SECURITY DEFINER functions are refused
// unless an operator allowlists them.
client.rpc(fn, args, { get, head, count })

// The same tables, Prisma-style. Sends the same requests as from(), but throws
// on failure instead of resolving { data, error }. Operators: equals not in gt
// gte lt lte contains startsWith endsWith. Embedded relations and or() stay on from().
client.db.posts.findMany({ where: { published: true, views: { gt: 100 } }, select: { id: true, title: true },
  orderBy: { created_at: 'desc' }, take: 20, skip: 40 })
client.db.posts.findFirst({ where: { id } })               // row | null
client.db.posts.create({ data: { title } })                // the inserted row
client.db.posts.updateMany({ where: { id }, data: { title } }) | .deleteMany({ where: { id } })
// Both resolve the affected rows, and refuse a where that matches no column:
// { id: undefined } would otherwise write every row.

// Auth → Better Auth's client: https://www.better-auth.com/docs. A sample of
// what is there; each plugin needs to be on in the project's Auth settings.
client.auth.signUp.email({ email, password, name })
client.auth.signIn.email({ email, password }) | .social({ provider, callbackURL }) | .anonymous()
client.auth.signIn.emailOtp({ email, otp }) | .magicLink({ email }) | .passkey() | .sso({ email, callbackURL })
client.auth.getSession()                        // { session, user }, asks the server
client.auth.signOut()
client.auth.listSessions() | .revokeSession({ token }) | .revokeOtherSessions() | .revokeSessions()
client.auth.updateUser({ firstName, lastName, image }) | .changePassword({ currentPassword, newPassword }) | .deleteUser({ password })
client.auth.listAccounts() | .linkSocial({ provider, callbackURL }) | .unlinkAccount({ providerId })
client.auth.emailOtp.sendVerificationOtp({ email, type }) | .requestPasswordReset({ email }) | .resetPassword({ email, otp, password })
client.auth.twoFactor.enable({ password }) | .verifyTotp({ code }) | .verifyOtp({ code }) | .disable({ password })
client.auth.organization.create({ name, slug }) | .list() | .setActive({ organizationId }) | .inviteMember({ email, role })
client.auth.passkey.addPasskey() | .listUserPasskeys() | .deletePasskey({ id })
client.auth.sso.register(...) | client.auth.apiKey.create(...) | client.auth.token()   // a JWT for the session

// Auth → what Motherbase adds to it
client.auth.onAuthStateChange((event, session) => {})  // INITIAL_SESSION | SIGNED_IN | USER_UPDATED | SIGNED_OUT
client.auth.getSessionFromUrl()                 // finishes an OAuth redirect, see below
client.auth.exchangeCodeForSession(code)        // the same with flowType: 'pkce'
client.auth.reauthenticate() | .updateUserCredentials({ email, password, nonce })
client.auth.admin.*                             // secret key only: list/get/create/update/delete/signOut/invite
client.hydrate()                                // the stored session, no network call: display only

// Storage → { data, error }. `path` is the object key inside the bucket, and it
// round trips. The file id returned by upload still works anywhere a path does.
client.storage.from(bucket).upload(path, file, { visibility, upsert })
client.storage.from(bucket).download(path, { transform })        // transform: see below
client.storage.from(bucket).remove([path])
client.storage.from(bucket).list(prefix, { limit, offset, search, sortBy })
client.storage.from(bucket).createSignedUrl(path, expiresIn, { transform })  // seconds, 1..604800
client.storage.from(bucket).createSignedUrls([path], expiresIn)  // per-entry results
client.storage.from(bucket).getPublicUrl(path, { transform })    // sync
client.storage.from(bucket).update(path, file)                   // upload with upsert on
client.storage.from(bucket).copy(from, to, { upsert }) | .move(from, to, { upsert })
client.storage.from(bucket).info(path) | .exists(path)           // 404 reads as false
client.storage.from(bucket).createSignedUploadUrl(path, { size, contentType })  // S3 driver
client.storage.from(bucket).uploadToSignedUrl(path, token, file)
client.storage.createBucket(id, { public, fileSizeLimit, allowedMimeTypes })  // secret key
// transform: { width, height, resize: 'cover'|'contain'|'fill', quality, format: 'origin'|'webp'|'avif' }

// Realtime
client.channel(name, { config: { broadcast: { self, ack }, presence: { key } } })
  .on('postgres_changes', { event, schema, table, filter }, cb)
  .on('broadcast', { event }, cb)
  .on('presence', { event: 'sync' | 'join' | 'leave' }, cb)
  .subscribe(status => {})            // SUBSCRIBED | TIMED_OUT | CLOSED | CHANNEL_ERROR
channel.send({ type: 'broadcast', event, payload })
channel.track(state); channel.untrack(); channel.presenceState()
client.removeChannel(channel)

// Edge functions → { data, error }. `error` is a FunctionsHttpError /
// FunctionsFetchError instance, but invoke still resolves rather than throws.
client.functions.invoke(name, { body, method, headers, auth })
```

## Resumable uploads

Large files go over TUS, exactly as on Supabase: the SDK does not bundle a TUS
client (supabase-js does not either), so use
[`tus-js-client`](https://github.com/tus/tus-js-client) against
`/storage/v1/upload/resumable`. Chunks must be 6 MB. Bucket limits, the key
collision check and storage policies are enforced when the upload is created,
and an unfinished upload can be resumed for 24 hours.

```ts
import { Upload } from 'tus-js-client';

const session = await client.hydrate();
const upload = new Upload(file, {
  endpoint: `${MOTHERBASE_URL}/storage/v1/upload/resumable`,
  chunkSize: 6 * 1024 * 1024,
  retryDelays: [0, 3000, 5000, 10000, 20000],
  headers: {
    authorization: `Bearer ${session?.access_token}`,
    apikey: MOTHERBASE_PUBLISHABLE_KEY,
    'x-upsert': 'true', // optional: replace an existing object
  },
  metadata: { bucketName: 'videos', objectName: 'u1/clip.mp4', contentType: 'video/mp4' },
  onProgress: (sent, total) => console.log(Math.round((sent / total) * 100), '%'),
  onSuccess: () => console.log('uploaded'),
});
upload.findPreviousUploads().then(previous => {
  if (previous[0]) upload.resumeFromPreviousUpload(previous[0]);
  upload.start();
});
```

## Password sign-in with MFA

When the account requires a second factor, password sign-in answers
`twoFactorRedirect: true` and the available `twoFactorMethods`. No session is
stored until verification succeeds.

```ts
const { data, error } = await client.auth.signIn.email({ email, password });
if (error) throw new Error(error.message);

if (data && 'twoFactorRedirect' in data) {
  // Show a code field. For an emailed or texted code, call twoFactor.sendOtp() first.
  const { error: verifyError } = await client.auth.twoFactor.verifyTotp({ code });
  if (verifyError) throw new Error(verifyError.message);
}

// The verified session is stored; onAuthStateChange reports MFA_CHALLENGE_VERIFIED.
```

The SDK includes the challenge cookie on sign-in and verification requests.
The project's CORS and cookie settings must allow the app's origin when the
app and API are on different sites. A UI toggle cannot bypass a second factor
required by the server.

## Social sign-in (OAuth)

A provider callback is a browser redirect, so it cannot answer the SDK with a
session the way a password sign-in does. Two calls, not one:

```ts
// 1. Wherever the button lives. Navigates the browser to the backend, which
//    redirects on to the provider.
await client.auth.signIn.social({
  provider: 'google',
  callbackURL: 'https://app.example.com/auth/callback',
});

// 2. On that page. Reads the token the backend appended to the redirect,
//    stores the session, and strips it from the address bar. createClient
//    already does this on load unless auth.detectSessionInUrl is false.
const { data, error } = await client.auth.getSessionFromUrl();
```

`getSessionFromUrl()` resolves with `data: null` and no error when there is
nothing to read, so calling it on every page load is safe.

Step 1 is a full-page navigation, not a fetch. That is deliberate: the backend
sets an OAuth state cookie there and re-checks it on the provider callback, and
a cookie set on a cross-site fetch response is refused by Safari and Firefox and
by Chrome in incognito. Navigating makes it a first-party cookie, so the flow
works in every browser even when your app and your API are on different domains.
If you are not using the SDK, point the button at the same URL:

```
https://<your-api>/api/auth/sign-in/social/google?callbackURL=https://app.example.com/auth/callback
```

`callbackURL` is validated against the trusted origins, so it has to be an
origin you allowlisted.

Two backend settings decide whether this works at all:

- **Callback URL.** Studio, Authentication, Sign In / Providers shows the exact
  URL to register in the provider's console.
- **CORS allowed origins.** Studio, Project Settings, Security (`server.cors`).
  If your app is served from a different origin than the API, that origin must
  be listed. Otherwise the browser refuses the cookie the sign-in start sets,
  and the provider callback comes back as `?error=state_mismatch`.

## Storage adapters

| Runtime  | Adapter                                                       |
| -------- | ------------------------------------------------------------- |
| Browser  | `localStorageStorage()` or `cookieStorage()`                  |
| SSR/Node | `memoryStorage()` (default), `serverCookieStorage(cookieMethods)` (getAll/setAll, see `@motherbase/ssr` for Next.js helpers), or a custom `{ get, set }` adapter |
| Expo/RN  | custom `{ get, set }` backed by `AsyncStorage`                |

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@motherbase/client';

const client = createClient(API_URL, ANON_KEY, {
  storage: {
    async get() {
      const raw = await AsyncStorage.getItem('session');
      return raw ? JSON.parse(raw) : null;
    },
    async set(session) {
      if (session) await AsyncStorage.setItem('session', JSON.stringify(session));
      else await AsyncStorage.removeItem('session');
    },
  },
});
```

## Compatibility matrix

The matrix is **not maintained by hand**. It lives in
[`COMPATIBILITY.md`](./COMPATIBILITY.md) and is generated by
`apps/server/tests/sdk-contract.integration.test.ts`, which runs every listed
supabase-js call against a live Motherbase server and a live Postgres. Each row
carries the id of the test that produced it.

Rows marked `Not supported` assert the current failure behaviour, so the day a
feature lands its test fails and the document has to be regenerated. That is the
mechanism that keeps this page from over-claiming (or under-claiming) again. CI
regenerates the file and fails if the committed copy differs.

Regenerate it locally with:

```bash
npm run test -w apps/server -- sdk-contract
```

More examples live in
[`docs/sdk.md`](https://github.com/JulienGuinot/motherbase/blob/master/docs/sdk.md).
Project Studio also exposes a project-specific Connect page with the exact API
URL, WebSocket URL and project ID to paste into `.env`.
