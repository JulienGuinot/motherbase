# Setup

There is one supported way to install and run Motherbase:

```bash
./setup.sh
```

It handles the environment files, secrets, Docker runtime, Traefik, image builds,
Console startup, health checks and the first operator account.

> **`./setup.sh` needs Docker and nothing else.** No Node version is required on
> the host: every build step (npm, Prisma, native addons, the Studio bundle) runs
> inside `node:22` containers. Images build in two stages — a shared deps image
> (`motherbase-deps`) compiles the native addons (argon2, isolated-vm) once, then
> the API and Console images derive from it in parallel, with BuildKit caching npm
> between rebuilds.

Building outside Docker is optional and not needed by `setup.sh`. It requires
Node >= 22.12.0:

```bash
nvm use
npm run install:all
npm run build
```

The full flag, prompt, generated-file and check reference is
[Setup script](https://www.motherbase.site/docs/self-hosting/setup-script/).

## Local

Run `./setup.sh` and choose **Local**. The Console starts at:

```text
http://localhost:5500/studio
```

Projects you create route automatically as `http://<name>.localhost`. No DNS.

## VPS

Run `./setup.sh`, choose **VPS**, and give a base domain such as `example.com`.
Setup then asks for one wildcard DNS record:

```dns
Type:  A
Name:  *
Value: <VPS_IP>
```

which covers:

```text
console.example.com
demo.example.com
demo-storage.example.com
demo-minio.example.com
```

After that, new projects under that domain need no DNS change. The Console
pre-fills `<project>.example.com` and Traefik routes on the `Host` header.

Notes:

- `*.example.com` does not cover `example.com` itself.
- If the Console domain is outside `example.com`, `setup.sh` prints the extra record.
- Custom external domains like `client.com` still need a record owned by that client.

## Unattended

```bash
DOMAIN=example.com ACME_EMAIL=admin@example.com ./setup.sh --yes --prod
```

Without `ADMIN_PASSWORD`, setup generates a strong secret and prints it once. To
supply your own in production, use a unique password of at least 16 characters:

```bash
DOMAIN=example.com ACME_EMAIL=admin@example.com \
  ADMIN_PASSWORD='your-unique-strong-password' ./setup.sh --yes --prod
```

Passwords that are too short, or on the weak list in `setup.sh`, are refused.

## Updates

One command, VPS or local:

```bash
./deploy/update.sh              # pull the current branch, then redeploy
./deploy/update.sh --no-pull    # redeploy the working tree as it is
```

It pulls, then runs `./setup.sh --yes`. It refuses to start when `.env` is missing
or the repo has uncommitted changes — the two states where an update turns into a
reinstall with fresh secrets that no longer open the existing database volume.

By hand, that is `git pull && ./setup.sh --yes`.

With an existing `.env`, `setup.sh` keeps the config and secrets, rebuilds the
shared images, then recreates Traefik and the Console. Project Postgres and MinIO
volumes are untouched.

Update each project afterwards from the Console (**Update**) or with:

```bash
motherbase projects update <id>   # pull + up
motherbase projects rebuild <id>  # rebuild from local code
```

Set `UPDATE_CHECK_URL` in `deploy/console/.env` to enable the Console's version
panel. It reports an available version and shows a guided plan; it applies
nothing on its own. Full detail:
[Updates](https://www.motherbase.site/docs/getting-started/updates/).

## Reset

```bash
./setup.sh --reset          # destroy this install's containers and volumes, then reinstall
./deploy/reset.sh [--yes]   # return the repo to a fresh post-clone state, start nothing
```

`deploy/reset.sh` removes every container, volume and network, the built images,
the generated `.env` files and `/srv/projects`. It is **not** an update path.
Pass `--keep-images` to leave the built images in place.

## Client SDK

```bash
npm run sdk:build     # build @motherbase/client from this repo
npm i @motherbase/client   # in your app
```

```ts
import { createClient, localStorageStorage } from '@motherbase/client';

// The publishable key is on Project Studio's Connect page.
const backend = createClient('https://demo.example.com', 'mb_publishable_...', {
  storage: localStorageStorage(),
});

await backend.hydrate();
await backend.auth.signIn.email({ email: 'me@example.com', password: '...' });
```

Full API: [SDK reference](https://www.motherbase.site/docs/reference/sdk/) and
[packages/client/README.md](packages/client/README.md).
