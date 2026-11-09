# create-motherbase-app

Create a frontend that uses `@motherbase/ui` and the Motherbase SDK.

```bash
npx create-motherbase-app my-app --template next
# or
npx create-motherbase-app my-app --template react
```

The command installs dependencies by default. Use `--no-install` for an offline
scaffold or `--yes` to accept the default project name and Next.js template.
It never overwrites an existing directory.

After creation, copy `.env.example` to `.env.local` and set the URL and public
key from your Motherbase project. Then run `npm run dev`.

Both templates include sign in, sign up, password reset, OAuth callback,
profile editing, passkeys and MFA settings. Configure visible OAuth providers
passkeys and MFA settings in `src/config/auth.ts` after enabling them in Motherbase. MFA is
enforced by the backend and appears automatically during sign in when needed.

The Next.js template uses App Router, `@motherbase/ssr` and Node.js Proxy. Its
`/app` route verifies the user on the server. The React template uses Vite and
React Router. Its route guard is for navigation only; backend authorization
still applies to every request.

The generated code is yours. Customize or remove its pages and styles as your
product grows. Node.js 22.12 or newer is required by these templates.
