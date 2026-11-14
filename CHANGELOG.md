# Changelog

Every release of the platform is a `vX.Y.Z` tag on this repository. The tag must
match the root `package.json` version and have a section here: the release job
publishes that section as the release notes and refuses to run without it
(`scripts/release-notes.cjs`). Add changes under **Unreleased** as they land,
then rename that heading to the version when you cut it.

The npm packages (`@motherbase/client`, `@motherbase/cli`, ...) carry their own
versions and are published separately; see [docs/publishing-the-sdk.md](docs/publishing-the-sdk.md).

## [Unreleased]

- Per-project runtime options, under **Backend control → Runtime**: turn the
  edge runtime container off for a project that runs no functions, and
  auto-pause a project after a delay without requests. Both are off by default
  for existing projects; a paused project stays stopped until someone starts it.
- Fewer database round trips per REST request: the RLS check rides on the
  statement that sets the request context, a resolved project key is remembered
  for 30 seconds (revoking one through the API forgets it at once), and a
  session the server reads for itself no longer gets a signed `set-auth-jwt`.
- The data plane (REST, storage, realtime broadcast) accepts the access token
  from `/api/auth/token` as a bearer and takes the caller from its claims, with
  no database query. Every token now carries `email`, `user_role`,
  `is_anonymous`, `user_status` and `iat_ms`. A token is refused before it
  expires when its session ends, its user changes, a backup is restored or the
  API restarts, in the API process that made the change; a change made in SQL
  or by another instance waits for the token's expiry.
- `@motherbase/client` sends that token on REST and storage requests, minted in
  the background and held in memory; the stored session and `access_token` are
  unchanged. `createClient(url, key, { accessTokens: false })` turns it off, and
  `createServerClient` from `@motherbase/ssr` always does.

## [1.0.0] - 2026-11-12

First public release.

- One VPS, one wildcard DNS record, any number of isolated projects, each with
  its own Postgres, storage, API, auth and Project Studio, run from the Platform
  Console.
- One-line install, `curl -fsSL https://www.motherbase.site/install.sh | bash`:
  downloads this release's bundle, refuses it unless its SHA-256 matches, and
  runs `setup.sh`. Every release bundle also carries a signed build provenance
  attestation.
- Releases are tags. Installs and `./deploy/update.sh` take the latest release,
  never the head of `master`.
- The documentation site lives in `website/`, next to the code it describes.
- Edge functions use the host's outbound proxy settings when it has them, so
  `npm:` and `jsr:` imports work on hosts that can only reach out through one.
- The server validates requests with zod 4, and the security overrides in
  `package.json` now reach the lockfile.
- `auth.users` follows Better Auth's user model, one column per fact. `name` is
  derived from `firstName`/`lastName` by a trigger, and `updateUser({ name })`
  sent alone over them answers 400. The avatar is Better Auth's `image` (the
  `imageUrl` column is merged into it). The legacy `googleId`/`appleId` columns
  become `account` rows. `client.auth.updateUser({ firstName, lastName })` is
  typed, and `UserProfileForm` edits first and last name.
- Indexes on `apikey.key`, `apikey.configId` and `passkey.credentialID`, which
  Better Auth looks them up by.
