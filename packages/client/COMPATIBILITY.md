<!--
  GENERATED FILE. Do not edit by hand.
  Written by apps/server/tests/sdk-contract.integration.test.ts.
  Regenerate with: npm run test -w apps/server -- sdk-contract
-->

# @motherbase/client vs supabase-js

Every row is produced by a contract test that runs the real `@motherbase/client` against a real Motherbase server backed by a real Postgres. Rows marked `Not supported` assert the current failure behaviour, so implementing the feature breaks the test and forces this table to be regenerated. The table cannot claim more or less than the code does.

Legend:

- `Supported`: behaves as supabase-js does.
- `Partial`: works, with the difference stated in the note.
- `Not supported`: not implemented today. The note says what happens if you call it.

Totals: 67 supported, 14 partial, 14 not supported (95 rows).

## Client

| Test id | Surface | Status | Notes |
| --- | --- | --- | --- |
| `client.createClient` | `createClient(url, key, options)` | Supported | The key is sent as an apikey header. Options cover session storage, a fetch override and extra headers. |
| `client.getChannels` | `client.getChannels()` | Supported | Returns the channels this client has created, as supabase-js does. |
| `client.options-shape` | `createClient(url, key, { auth, db, global })` | Supported | supabase-js nests its options under auth, db, global and realtime, and ported code passes them that way. Both spellings are read, the flat one winning where they collide, so { auth: { persistSession } } and { global: { headers, fetch } } take effect instead of being silently dropped. auth.storage accepts either adapter shape, including a React Native AsyncStorage. |
| `client.rpc` | `client.rpc(fn, args)` | Supported | POST and GET /rest/v1/rpc/:fn resolve a public function from the catalog and call it with named arguments inside the caller RLS transaction. SECURITY DEFINER functions are refused unless an operator allowlists them, and an unknown function is a 404. |
| `client.schema` | `client.schema('other') / createClient(url, key, { db: { schema } })` | Partial | schema('public') is the client. schema(name).rpc() calls functions in another schema through the Content-Profile/Accept-Profile headers, for the schemas a feature exposes (Queues' pgmq_public); any other is refused with PGRST106. Tables are served from public only, so schema(name).from() and the db.schema constructor option throw with the reason rather than reading public under another name. |
| `client.typed-database` | `createClient<Database>(url, key)` | Supported | motherbase gen types typescript emits the supabase-js Database shape (Row, Insert, Update, Relationships, Enums, Functions) from the Postgres catalog, and createClient<Database> types from() and rpc() from it. Unknown columns are still rejected at runtime as well. |

## Data · verbs

| Test id | Surface | Status | Notes |
| --- | --- | --- | --- |
| `data.verb.delete` | `from(t).delete().eq(col, v)` | Supported | Deleted rows are returned when .select() is requested. The delete is bound to the row versions whose realtime audience was captured. |
| `data.verb.delete.unfiltered` | `from(t).delete()` | Partial | An unfiltered delete is refused with 400 for non-admin callers, on purpose. supabase-js would delete every visible row. |
| `data.verb.insert.bulk` | `from(t).insert([rowA, rowB])` | Supported | An array body is compiled into one multi-row INSERT. Rows may declare different key subsets; a key a row omits is written as DEFAULT so the column default applies. |
| `data.verb.insert.single` | `from(t).insert(row)` | Supported | One row per call; .select() returns it with server defaults applied. Without .select(), data is null. |
| `data.verb.select` | `from(t).select('*')` | Supported | Awaitable, resolves to { data, error } and never throws for an API error. |
| `data.verb.update` | `from(t).update(values).eq(col, v)` | Supported | Returns the updated rows when .select() is requested. A filter that matches nothing is a 404 rather than an empty array. |
| `data.verb.upsert` | `from(t).upsert(rows, { onConflict })` | Supported | A real INSERT ... ON CONFLICT DO UPDATE. The conflict target is ?on_conflict= or the catalog primary key, and a row that actually conflicted emits an updated realtime event rather than a created one. |
| `data.verb.write-returning` | `from(t).insert(row).select()` | Supported | Writes return no rows by default. Add .select() to opt into a representation, subject to the caller’s SELECT policy. |

## Data · filters

| Test id | Surface | Status | Notes |
| --- | --- | --- | --- |
| `data.filter.containedBy-overlaps` | `from(t).containedBy(col, v) / .overlaps(col, v)` | Supported | Compiled to the contained-by and overlap operators, on array and range columns. |
| `data.filter.contains` | `from(t).contains(col, value)` | Supported | Compiled to the containment operator. It applies to array, range and jsonb columns; used on a scalar column it is a 400 rather than a silently empty result. |
| `data.filter.eq` | `from(t).eq(col, v)` | Supported | Compiled to a parameterised equality. |
| `data.filter.filter` | `from(t).filter(col, op, value)` | Supported | The escape hatch reaches any operator in the dialect, including ones with no dedicated builder method. |
| `data.filter.gt-gte-lt-lte` | `from(t).gt/gte/lt/lte(col, v)` | Supported | All four compile to the matching SQL comparison. |
| `data.filter.ilike` | `from(t).ilike(col, pattern)` | Supported | Case-insensitive ILIKE with PostgREST anchoring, so %ETA means "ends with eta" rather than a substring match. |
| `data.filter.in` | `from(t).in(col, [..])` | Supported | Compiled to an IN list. The client quotes any value that needs it, so a value containing a comma stays one value instead of splitting into two. |
| `data.filter.is` | `from(t).is(col, null \| true \| false)` | Supported | is null becomes IS NULL. Boolean forms become an equality. |
| `data.filter.json-path` | `from(t).eq('col->>key', v)` | Supported | A jsonb path operand is parsed and compiled. The text arrow compares as text, the object arrow compares as jsonb, and every path segment is bound as a parameter rather than interpolated. |
| `data.filter.like` | `from(t).like(col, pattern)` | Supported | Case-sensitive LIKE with PostgREST anchoring. * is translated to %, and an unanchored pattern is an exact match. |
| `data.filter.match` | `from(t).match({ col: v })` | Supported | Expanded into one equality filter per key, all ANDed together. |
| `data.filter.neq` | `from(t).neq(col, v)` | Supported | Compiled to !=, so NULL values are excluded exactly as in PostgREST. |
| `data.filter.not` | `from(t).not(col, op, value)` | Supported | Emitted as a not. prefix and honoured on every operator, including not.is.null. |
| `data.filter.or` | `from(t).or('a.eq.1,b.eq.2')` | Supported | Emitted as an or group and compiled recursively, so a nested and() inside it works too. |
| `data.filter.range-operators` | `from(t).rangeGt/rangeGte/rangeLt/rangeLte/rangeAdjacent` | Supported | Emitted as the strictly-left, strictly-right, not-extending and adjacent operators. The compat fixture has no range column, so this pins the emitted encoding rather than a result set. |
| `data.filter.textSearch` | `from(t).textSearch(col, query)` | Supported | Maps to the four text-search operators, with an optional configuration rendered in parentheses. |

## Data · modifiers

| Test id | Surface | Status | Notes |
| --- | --- | --- | --- |
| `data.modifier.abortSignal` | `from(t).select().abortSignal(signal)` | Supported | The signal is handed to fetch, so an aborted query settles as an error instead of resolving rows. |
| `data.modifier.csv-explain` | `from(t).select().csv() / .explain()` | Partial | csv() returns RFC 4180 text. explain() is admin-only: the server answers 403 for a normal caller, so an application cannot rely on it. |
| `data.modifier.limit` | `from(t).limit(n)` | Supported | Sent as ?limit=n. The server caps it at the console-tunable api.rest.maxRows (1000 by default). |
| `data.modifier.limit.foreignTable` | `from(t).limit(n, { foreignTable })` | Supported | Emitted as <relation>.limit and applied to the embedded subquery, so a parent keeps all its rows while its children are capped. |
| `data.modifier.maxAffected-rollback` | `from(t).update(v).maxAffected(n) / .rollback()` | Supported | maxAffected rejects and rolls back writes above the limit; rollback performs a dry run. Both preserve transaction atomicity even when no rows are requested. |
| `data.modifier.maybeSingle` | `from(t).select().maybeSingle()` | Supported | Resolves the first row or null. Applied client side. |
| `data.modifier.order` | `from(t).order(col, { ascending })` | Supported | Multiple order() calls are concatenated into one ?order= list, as PostgREST does. |
| `data.modifier.order.options` | `from(t).order(col, { nullsFirst, referencedTable })` | Supported | nullsFirst emits the nullsfirst and nullslast qualifiers, and referencedTable scopes the ordering to an embedded relation. |
| `data.modifier.range` | `from(t).range(from, to)` | Supported | Translated to limit and offset. The server also reads a Range request header and always answers with Content-Range and Range-Unit. |
| `data.modifier.returns` | `from(t).select().returns<T>()` | Supported | A compile-time cast helper. It changes no request, matching supabase-js. |
| `data.modifier.setHeader` | `from(t).select().setHeader(name, value)` | Supported | Sends the header with that request only. It is how a CAPTCHA token reaches a table guarded under Attack Protection. |
| `data.modifier.single` | `from(t).select().single()` | Supported | Resolves one row, or a PGRST116 error when the result is not exactly one row. Applied client side. |
| `data.modifier.throwOnError` | `from(t).select().throwOnError()` | Supported | Rejects instead of resolving { data: null, error }, so ported code using try/catch works. Without it the envelope is still the default, in both SDKs. |

## Data · response

| Test id | Surface | Status | Notes |
| --- | --- | --- | --- |
| `data.response.count` | `from(t).select('*', { count: 'exact' })` | Supported | Prefer count=exact, planned or estimated is honoured, and the total comes back with a Content-Range header computed in the same transaction as the rows. |
| `data.response.default-limit` | `from(t).select() with no limit` | Supported | An unbounded select returns up to api.rest.maxRows (1000 by default), which is what PostgREST does with db-max-rows and what a Supabase app was built against. One number governs both the default and the ceiling, so lowering it is how you cap an unbounded read. |
| `data.response.embedding` | `from(t).select('*, author(*)')` | Supported | Embedded resources compile to correlated LATERAL subqueries inside the same RLS transaction, so embedded rows are policy-filtered too. Aliases, !inner, FK hints, nested filter/order/limit and the count aggregate all work. |
| `data.response.error-shape` | `{ data, error } result envelope` | Supported | Expected API failures resolve rather than throw. error is { message, status, code }. |
| `data.response.select-alias-cast` | `from(t).select('alias:col, col::text')` | Supported | Renamed columns and casts both compile. A cast target must be a bare lowercase type name with an optional array marker, so it cannot smuggle SQL. |
| `data.response.select-projection` | `from(t).select('id,label')` | Supported | Column lists are validated against the table and compiled into the SELECT list. |

## Auth

| Test id | Surface | Status | Notes |
| --- | --- | --- | --- |
| `auth.admin` | `auth.admin.*` | Partial | User administration, MFA factor administration (admin.mfa.listFactors / deleteFactor) and generateLink, only with a secret project API key. This is Motherbase's API, shaped like supabase-js, not Better Auth's admin plugin. Narrower than the supabase service role, which also opens SQL and DDL. generateLink covers signup, invite, magiclink and recovery; recovery is code-based here, so it returns email_otp and no action_link, and email_change_* is refused. |
| `auth.better-auth` | `auth.<any Better Auth client method>` | Supported | client.auth is Better Auth's client, typed with every plugin the server mounts (anonymous, email OTP, magic link, phone number, two-factor, organization, generic OAuth, JWT, passkey, SSO, API keys). Method names, parameters and the { data, error } results are Better Auth's, so its documentation applies as written; the SDK stores the session it returns, which is what from(), storage and realtime then send. |
| `auth.deleteUser` | `auth.deleteUser()` | Partial | Better Auth's deleteUser: self-service, which supabase-js only offers to an admin. It takes the password (or a fresh session), and clears the local session once the account is gone. |
| `auth.exchangeCodeForSession` | `auth.exchangeCodeForSession(code) / getSessionFromUrl(href?)` | Supported | With flowType 'pkce' the S256 challenge rides on the callback URL and the redirect returns ?code=, exchanged once against the verifier this browser kept (automatically on load, as detectSessionInUrl does). The implicit flow remains the default: the token comes back in the fragment and getSessionFromUrl reads it and strips it from the URL. |
| `auth.getClaims` | `auth.getClaims()` | Not supported | Use auth.token(): a Better Auth session token is an opaque bearer, so the jwt plugin mints a JWT for the session. Verify it server side against /api/auth/jwks. |
| `auth.getSession` | `auth.getSession()` | Partial | Better Auth's getSession: it asks the server, so it is the verified read, and returns { session, user } with Better Auth's session row rather than a token pair. A session the server no longer knows is cleared locally. The stored session without a network call is client.hydrate(). |
| `auth.getUser` | `auth.getUser()` | Not supported | Use auth.getSession(), which asks the server and returns the user with the session. |
| `auth.identities` | `auth.getUserIdentities() / linkIdentity() / unlinkIdentity()` | Not supported | Use auth.listAccounts(), auth.linkSocial({ provider, callbackURL }) and auth.unlinkAccount({ providerId }). A password account lists its credential account. |
| `auth.mfa` | `auth.mfa.*` | Not supported | Use auth.twoFactor: enable({ password }) returns the TOTP URI and backup codes, verifyTotp / verifyOtp / verifyBackupCode finish a sign-in that answered twoFactorRedirect, disable({ password }) turns it off. The aal the server stamps on a session is on auth.getSession(). |
| `auth.onAuthStateChange` | `auth.onAuthStateChange(cb)` | Supported | Fires INITIAL_SESSION once on subscribe, as supabase-js does, so an app that clears its loading flag on that event also clears it for a signed-out visitor. Then SIGNED_IN, USER_UPDATED, MFA_CHALLENGE_VERIFIED and SIGNED_OUT as the Better Auth calls change the session. There is no TOKEN_REFRESHED: Better Auth sessions are not rotated. Returns { data: { subscription } }. |
| `auth.refreshSession` | `auth.refreshSession() / startAutoRefresh()` | Not supported | Better Auth sessions have no refresh token to rotate. auth.getSession() revalidates, and the client already does so on a 401. |
| `auth.resetPassword` | `auth.resetPasswordForEmail(email)` | Not supported | Use auth.emailOtp.requestPasswordReset({ email }), then auth.emailOtp.resetPassword({ email, otp, password }): the reset is completed with a one time code rather than a redirect link. |
| `auth.session-shape` | `session.access_token / user.user_metadata` | Partial | The session the SDK stores (client.hydrate(), onAuthStateChange) carries the supabase-js spellings alongside the native ones: access_token, refresh_token (always null), token_type, and on the user aud, role, created_at, email_confirmed_at, phone, identities and user_metadata holding the profile fields. app_metadata is {} rather than a guessed provider, and expires_at is absent. Better Auth's own responses keep its native shape. |
| `auth.setSession` | `auth.setSession({ access_token, refresh_token })` | Not supported | A session token from elsewhere is adopted through the storage adapter the client is created with, or through auth.getSessionFromUrl() on an OAuth return. |
| `auth.signInWithIdToken` | `auth.signInWithIdToken({ provider, token })` | Not supported | Use auth.signIn.social({ provider, idToken: { token } }), for Sign in with Apple and Google One Tap from a native app. The provider must be configured on the backend. |
| `auth.signInWithOAuth` | `auth.signInWithOAuth({ provider, options })` | Not supported | Use auth.signIn.social({ provider, callbackURL }). In a browser it navigates to the server's start route, which keeps the OAuth state cookie first-party; disableRedirect: true returns the URL instead. The redirect back is completed by getSessionFromUrl(), on load by default. |
| `auth.signInWithOtp` | `auth.signInWithOtp({ email \| phone }) then auth.verifyOtp({ token })` | Not supported | Use auth.emailOtp.sendVerificationOtp({ email, type: 'sign-in' }) then auth.signIn.emailOtp({ email, otp }); by SMS, auth.phoneNumber.sendOtp and auth.phoneNumber.verify, when the phone-number plugin is on with a sender configured. Magic links are auth.signIn.magicLink. |
| `auth.signInWithPassword` | `auth.signInWithPassword({ email, password })` | Not supported | Use auth.signIn.email({ email, password }). The session is stored through the configured storage adapter and SIGNED_IN fires; with two-factor on, the answer is { twoFactorRedirect: true } and no session until auth.twoFactor verifies a code. |
| `auth.signInWithSSO` | `auth.signInWithSSO({ domain })` | Not supported | Use auth.signIn.sso({ email, callbackURL }), or name the provider by domain, providerId or organizationSlug instead of email. The project needs the SSO plugin on and a provider registered; providers are managed with auth.sso.*. |
| `auth.signOut` | `auth.signOut()` | Supported | Better Auth's signOut: revokes the server session and clears the local one. Other devices are auth.revokeOtherSessions(), every device auth.revokeSessions(). |
| `auth.signUp` | `auth.signUp({ email, password })` | Not supported | Use auth.signUp.email({ email, password, name }). It answers { token, user }, with a null token while the project requires email verification first. |
| `auth.updateUser` | `auth.updateUser({ data, email, password })` | Partial | Better Auth's updateUser takes the profile fields flat ({ name, image, ...additional fields }), not under data. A password is auth.changePassword({ currentPassword, newPassword }); an anonymous user's first email, a first password, or a password replaced with the nonce from auth.reauthenticate() is auth.updateUserCredentials(). |

## Storage

| Test id | Surface | Status | Notes |
| --- | --- | --- | --- |
| `storage.bucket-admin` | `storage.createBucket/getBucket/listBuckets/updateBucket/emptyBucket/deleteBucket` | Partial | All six are on the client and every one needs a secret project API key, which is the same rule Supabase applies to bucket administration. With a publishable key they resolve with a 401 rather than a partial answer. deleteBucket refuses a bucket that still holds objects unless force is passed, so one unqualified call cannot destroy the files in it. |
| `storage.createSignedUrl` | `storage.from(b).createSignedUrl(path, expiresIn)` | Partial | expiresIn is read, in seconds, and validated from 1 second to 7 days (the AWS SigV4 ceiling); a longer lifetime is refused rather than quietly clamped. It resolves to { signedUrl, expiresAt }, and expiresAt is null when nothing actually expires: a public object URL is permanent, and a private object on the local driver resolves to the authenticated streaming endpoint, which is bound to the session rather than to a clock. |
| `storage.createSignedUrls` | `storage.from(b).createSignedUrls(paths, expiresIn)` | Supported | Signs each key and reports per entry, so a missing object yields one entry carrying an error instead of failing the batch. There is no batch endpoint behind it: it is one request per key. |
| `storage.download` | `storage.from(b).download(path)` | Supported | Resolves a Blob, addressed by the key the object was uploaded under. A file id is still accepted. |
| `storage.getPublicUrl` | `storage.from(b).getPublicUrl(path)` | Supported | Synchronous, returns { data: { publicUrl } } built from the client base URL. |
| `storage.info-exists` | `storage.from(b).info(path) / .exists(path)` | Supported | info returns the object's metadata without its body, in the supabase-js shape. exists reports false only for a 404: an authorization failure is reported as an error, because treating one as absence is how a UI offers to create something that is already there. |
| `storage.list` | `storage.from(b).list(prefix, options)` | Supported | Lists objects under a prefix in the Supabase response shape (name, id, created_at, updated_at, metadata), with limit, offset, search and sortBy. Keys come back relative to the bucket. |
| `storage.move-copy` | `storage.from(b).move(from, to) / .copy(from, to)` | Supported | Both work within one bucket. The bytes stream through the upload path, so bucket quota, the size guard and the mime allowlist apply to a copy exactly as to a fresh upload. move deletes the source only once the copy has landed. |
| `storage.remove` | `storage.from(b).remove([path])` | Supported | Addressed by the key the object was uploaded under, as in supabase-js, and reported per entry. A bare file id still resolves, exactly as it does for download. |
| `storage.signed-upload` | `storage.from(b).createSignedUploadUrl(path) / .uploadToSignedUrl(path, token, file)` | Partial | Both exist and land the object at the key you asked for, but createSignedUploadUrl needs the byte size and content type up front: the upload is reserved against the bucket quota and the signature is bound to that exact length, which is what stops a signed URL becoming an unbounded write. Requires the S3 driver; the local driver has no presigned uploads. |
| `storage.transform` | `storage.from(b).download(path, { transform })` | Supported | Also getPublicUrl and createSignedUrl with { transform }, served by /storage/v1/render/image with Supabase limits. Without format, WebP is negotiated from Accept. |
| `storage.update` | `storage.from(b).update(path, file)` | Supported | upload with upsert forced on, exactly as in supabase-js. |
| `storage.upload` | `storage.from(b).upload(path, file, options)` | Supported | The key is the one you passed. avatars/{uid}/pic.png style paths round trip through upload, download, remove and the signed URL. The file id keeps working everywhere a path does. |
| `storage.upload.options` | `storage.from(b).upload(path, file, { upsert, contentType })` | Partial | upsert works: without it a second write to the same key is a 409, with it the object is replaced. contentType overrides what the file itself declares. supabase-js' cacheControl is not part of UploadOptions, so a ported call naming it is a type error rather than a silently dropped option: cache headers are decided by the driver and, for a transform, by the render endpoint. |

## Realtime

| Test id | Surface | Status | Notes |
| --- | --- | --- | --- |
| `realtime.broadcast` | `channel(n).on('broadcast', { event }, cb) and channel.send(...)` | Supported | Routed by topic. config.broadcast.self and config.broadcast.ack are both honoured. |
| `realtime.channel.private` | `channel(n, { config: { private: true } })` | Supported | The flag is sent in the join payload; the server then checks the RLS policies on realtime.messages (SELECT to receive, INSERT to send or track). |
| `realtime.channel.unknown-event` | `channel(n).on('system', ...)` | Not supported | Only broadcast, presence and postgres_changes are accepted. Anything else throws immediately. |
| `realtime.postgres_changes` | `channel(n).on('postgres_changes', { event, schema, table, filter }, cb).subscribe()` | Supported | INSERT, UPDATE, DELETE and * are delivered with the supabase payload shape. Server side the stream is RLS filtered. |
| `realtime.presence` | `channel(n).on('presence', ...) with track/untrack/presenceState` | Supported | The server sends full state and the client diffs it into sync, join and leave, keyed by config.presence.key. |
| `realtime.removeChannel` | `client.removeChannel(channel) / client.removeAllChannels()` | Supported | Unsubscribes and drops the channel, resolving to "ok". |
| `realtime.subscribe.status` | `channel.subscribe(status => {})` | Supported | Reports SUBSCRIBED, TIMED_OUT, CLOSED and CHANNEL_ERROR, as supabase-js does. |

## Edge functions

| Test id | Surface | Status | Notes |
| --- | --- | --- | --- |
| `functions.invoke` | `functions.invoke(name, { body })` | Supported | POSTs the JSON body to /api/edge/:name with the current session bearer attached. |
| `functions.invoke.error` | `functions.invoke error handling` | Partial | invoke resolves { data: null, error } rather than throwing, but error is a real FunctionsHttpError (or FunctionsFetchError when the request never reached the server), so an instanceof check ported from supabase-js still works. |
| `functions.invoke.options` | `functions.invoke(name, { headers, method, region })` | Partial | method and headers are honoured: the invoke route answers every verb and forwards the request headers to the function, so a function reading req.method sees the one you asked for. region is accepted and ignored, because a self-hosted Motherbase runs its functions in one place. |
