# Publishing the client SDK and wiring it into a frontend

Everything you have to do by hand to publish the public `@motherbase/client` SDK
and consume it from a frontend project.

For the API surface itself, see [`sdk.md`](sdk.md). For SSR helpers, see
[`packages/ssr`](../packages/ssr).

---

## 1. Build the SDK

From the repository root:

```bash
npm run sdk:build      # builds @motherbase/contracts, then the client SDK
```

Output lands in `packages/client/dist/`. Rebuild after any change under
`packages/client/src/`. Running `npm run build` from `packages/client` also
builds the contracts first. Both packages rebuild automatically before
`npm pack` or `npm publish` through their `prepack` hook.

---

## 2. Choose a distribution method

### Option A: npm registry (recommended)

1. Create an npm account at <https://www.npmjs.com> if you don't have one.
2. Log in: `npm login`
3. Bump the version before each publish:
   ```bash
   cd packages/client
   npm version patch --no-git-tag-version    # or minor / major
   ```
4. Inspect the package: `npm pack --dry-run`. Check that `dist/index.js`,
   `dist/index.d.ts`, and the `query` and `testing` entry points are included.
5. Publish: `npm publish --access public`, from a clean checkout of a commit
   that is on `master`.
6. Commit the version bump and push it. npm and this repository must name the
   same version for the same code: 2.2.4 was once published from a tree that was
   never committed, so the repository said 2.2.3 for a week while npm served
   code it did not contain.
7. Install in your app: `npm i @motherbase/client@latest`

If a version was published without `dist/`, publish a new patch version:
npm does not allow replacing an existing version. If contracts changed,
build and publish `@motherbase/contracts` first and update the client's
dependency range to include the required version.

Publish `@motherbase/ssr` the same way if you changed it. It depends on
`@motherbase/client`, so publish the client first.

### Option B: local link, development only

In your frontend's `package.json`:

```json
{
  "dependencies": {
    "@motherbase/client": "file:../motherbase/packages/client"
  }
}
```

Then `npm install`, and rebuild the SDK whenever you change it. Not for
production deploys: the path has to resolve on every machine that builds.

### Option C: self-hosted Verdaccio registry

```bash
npx verdaccio                                     # starts on http://localhost:4873
npm set registry http://localhost:4873
npm adduser --registry http://localhost:4873
```

Publish and install exactly as in Option A, against your own registry. Useful
for air-gapped environments.

---

## 3. Configure the client in your frontend

```ts
import { createClient, localStorageStorage } from '@motherbase/client';

export const backend = createClient(
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5001',
  process.env.NEXT_PUBLIC_MOTHERBASE_KEY,   // the project's publishable key
  { storage: localStorageStorage() },       // omit for SSR / Node
);

// Call once at app startup (_app.tsx, main.tsx, ...)
await backend.hydrate();
```

Point `NEXT_PUBLIC_API_URL` (Next.js) or `VITE_API_URL` (Vite) at the public URL
of your deployed backend, the same host that serves Studio.

---

## 4. Allow your frontend origin

Add the frontend's origin to the project's CORS allowlist: Project Studio, Project
Settings, Security (the `server.cors` settings group, read on every request, no
restart). `CORS_ORIGINS` in the backend `.env` (plural, comma-separated) is only the
fallback used when the settings table cannot be read:

```
CORS_ORIGINS=https://your-frontend-domain.com,http://localhost:3000
```

---

## 5. Query tables through the REST API

Tables created from Studio are exposed immediately at `/rest/v1/<table>`, with
PostgREST-style filtering:

```
GET /rest/v1/products?price=lt.50&order=name.asc&limit=20
```

Through the SDK:

```ts
const { data, error } = await backend.from('products').select('*').lt('price', 50);
```

Row level security is enabled on public tables by default, so a table with no
policy returns nothing until you add one. See [`rls.md`](rls.md).

---

## 6. Realtime

```ts
const channel = backend
  .channel('room:1')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, (payload) =>
    console.log(payload),
  );

channel.subscribe(status => console.log(status)); // returns the channel, not a promise
```

Broadcast and presence use the same channel object. `client.realtime.watchTable()`
is a legacy low-level watcher kept for backwards compatibility; prefer channels.

---

## 7. Checklist before going to production

- [ ] `packages/client` built and published or installed
- [ ] `NEXT_PUBLIC_API_URL` / `VITE_API_URL` points at the production backend
- [ ] The project's CORS allowlist (`server.cors`) lists the production frontend domain
- [ ] `JWT_SECRET` is a strong random value (`openssl rand -hex 32`), not a default
- [ ] S3 / storage credentials configured if you use file upload
- [ ] SMTP credentials configured if you use auth emails or invites
- [ ] `DATABASE_URL` points at the production Postgres instance
- [ ] `prisma migrate deploy` run against the production database
- [ ] RLS policies written for every table you expose
