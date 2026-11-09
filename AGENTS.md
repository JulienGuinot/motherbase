# Rules for agents working on this repo

These are rules, not style preferences. Each one guards against a failure that
type-checking and a green test run will not catch on their own.

A release tag deploys. `.github/workflows/ci.yml` runs lint, build and tests on
every push; a `vX.Y.Z` tag also publishes the release (images, install bundle,
attestation) and the `deploy-vps` job ships it to the VPS on green. `master` is
what the next release will be, so a commit that reaches `master` is a commit the
next release ships. Never push a tag you were not asked to push.

---

## 1. Run the gates before you claim anything

CI runs these, in this order, and the deploy is gated on them:

```bash
npm run infra         # Postgres + MinIO. The integration tests need them.
npm run verify        # lint && build && test: the same three, in one command
```

**A partial check is not a check.** Running `tsc --noEmit` in one workspace and
the tests of another proves nothing about the build.

Without `npm run infra`, about 21 test files fail with `Can't reach database
server` / `ECONNREFUSED`. **That is the only failure signature you may attribute
to the environment.** A module that will not resolve, a type error, a failed
assertion: those are real. Read the failures before deciding which kind you
have.

`npm run build` is the gate that matters most, because it is the one the
Dockerfile runs: if it fails, the deploy image cannot be produced at all.

## 2. Never claim a gate you did not run

Say which commands you ran and what they printed. If you did not run something,
say that too, in the same breath. "Tests pass" when you ran one workspace's
tests is a false statement, and it is the statement that gets things deployed.

If a check is impossible in this environment (no Docker, no Postgres), name the
check, name why, and name what you did instead.

## 3. Every import must be a declared dependency

A bare `import x from 'pkg'` requires `pkg` in that workspace's `package.json`
or the root one. Not in `node_modules`. **Declared.**

npm hoists transitive dependencies to the root `node_modules`, so an undeclared
import can resolve on one machine and fail in the production image build. Before
adding an import, check it is declared. If it resolves but is not declared, it
is a bug waiting for a different machine.

## 4. Type-checking is not evidence for runtime or visual behaviour

`tsc` and unit tests cannot see: layout, colour, z-order, stacking, focus,
scroll, cache staleness, or anything about what is actually on screen. A
`background: inherit` that resolves to transparent, or a query cache that keeps
the previous table's rows under the next table's headers, type-checks
perfectly.

For a change that is visual or stateful at runtime: run the app
(`npm run studio:mock`, then `http://localhost:5173/studio`. Note the
basePath), look at it, and say what you saw. If you could not, say the change is
unverified rather than implying it is not.

## 5. Fix the class, not the instance

Before patching a symptom, grep for its siblings. If the same shape appears more
than once, fix it where all callers route through.

A guard in a shared function is a smaller diff than a guard in every caller,
and patching only the path the report names leaves every sibling broken.

## 6. Both sides of a contract change together

When you change a limit, a shape, or an enum, grep for the other side. A server
that clamps `pageSize` to 100 while the grid offers 200 is two files that are
each internally valid and wrong together.

## 7. Read every commit you are about to push

Especially any that you did not write. `.github/`, `deploy/`, `Dockerfile`,
`docker-compose*.yml`, `setup.sh` and lockfiles have effects outside this
repository.

`git log --oneline origin/master..HEAD` and `git diff origin/master..HEAD --stat`
before every push. If a commit is not yours, say so and say what it contains.

## 8. Run no command for its side effects "just in case"

Only run what the task needs. Commands that mutate repository state (`git
init`, `git config`, `npm install`, `prisma migrate`, `rm`) are never
incidental setup.

## 9. Tests never enter the runtime build

`apps/server` builds with `tsconfig.build.json`, which excludes `tests/`. The
base `tsconfig.json` still covers them, so the editor, eslint and `tsc --noEmit`
type-check tests exactly as before.

Do not point the build script back at the base config. A test is not part of the
runtime, and one broken test file must not be able to fail `docker build`.

## 10. Optimistic writes must be reversible

Any write to the React Query cache ahead of the server must capture a snapshot
and restore it `onError`. A UI that shows a delete that did not happen is worse
than a UI that is slow.

Partial failure is real: bulk operations issue one request per item, so some may
land before one fails. Roll back and refetch. The refetch is what settles which
ones survived.

## 11. Leave a runnable check behind

Non-trivial logic (a branch, a parser, a money or security path, a cache
transform) gets one small test that fails if the logic breaks. No frameworks
beyond the vitest already here. Trivial one-liners need no test.

Prefer extracting the pure part and testing that over mounting the world.

## 12. A failure must answer, and its log must say why

Express 4 drops the promise an async handler returns. `apps/server/lib/express-async-errors.ts`
forwards those rejections to `next(err)` in every app; it is imported by
`app.ts`, `console/server.ts` and `console/orchestration/app.ts`, and a test
fails if one of them stops importing it. Every new Express entrypoint imports
it too. Delete it when moving to Express 5, which does this natively.

`return promise` inside `try` is not `return await promise`: only the second
reaches the `catch`.

Log a caught value with `describeError` (`lib/errors.ts`), never `err.stack`
alone. Some libraries throw errors with an empty `stack` and `message` and put
the explanation elsewhere (better-call's `APIError` uses `status`, `body` and
`errorStack`); `describeError` reads those.

Better Auth checks every table its enabled plugins write against the Prisma
client before answering anything, so a schema that lags a plugin takes down all
of auth, sign-in included. `tests/project-auth-instance.unit.test.ts` runs that
check offline with every plugin turned on: when you upgrade Better Auth or add a
plugin, that test is what tells you the schema has to move.

---

## Where things are

- `apps/server`: API + platform console backend. `npm run build` runs
  `prisma generate` then `tsc -p tsconfig.build.json`.
- `apps/studio`: Next.js console. **`basePath: '/studio'`**, `/` is a 404.
  `npm run studio:mock` for UI work without a backend.
- `website/`: the documentation and marketing site (Next.js, served at
  www.motherbase.site). Not a workspace, not in any image or in the install
  bundle: it has its own `package.json` and lockfile, so run its checks from
  inside it (`cd website && npm ci && npm run lint && npx tsc --noEmit && npm test
  && npm run build`). The docs under `website/content/docs/` describe this code:
  when the two disagree, the code is right and the doc is fixed in the same
  change (rule 6). Five tables in it are generated here and copied by
  `npm run docs:sync` from inside `website/`; its tests fail when one is stale.
- `packages/*`: client SDK, contracts, CLI, SSR, AI. There is no `packages/mcp`:
  the MCP server ships as `motherbase mcp`, implemented in
  `packages/cli/src/mcp/`.
- New request validation in `apps/server` is `zod`: it is already the majority
  (`config/settings/*`, `console/`), and gives type inference `express-validator`
  (3 controllers: `user`, `device`, `notification`) doesn't. Don't add new
  `express-validator` routes: migrate one to `zod` when you next touch it, but
  this is not a mandate to batch-convert the rest.
- Integration tests need Postgres and MinIO: `npm run infra` (`npm run
  infra:down` to stop). Without them, the `*.unit.test.ts` files still run and
  pass; the rest fail on connection. See rule 1 before calling any failure
  environmental.

## Reporting

State what changed, what you ran, what you did not run, and what you chose not
to do. If you found a real problem outside the task, name it and leave it.
Do not silently widen the scope, and do not silently narrow it either.

A report goes in your reply, not in a new file. `docs/` is for how the code
works today: a dated audit or review there goes stale the day its findings are
fixed.

## Note

Your code will be reviewed by humans. It has to be readable, deliberate, and
follow the codebase's patterns.
