# __APP_NAME__

Next.js App Router starter with Motherbase authentication.

1. Copy `.env.example` to `.env.local`.
2. Set `NEXT_PUBLIC_MOTHERBASE_URL` and `NEXT_PUBLIC_MOTHERBASE_KEY` to your project's API URL and public key. Never use an admin or secret key here.
3. Run `npm run dev`, then open `http://localhost:3000`.

Add `http://localhost:3000/auth/callback` to your project's allowed Auth redirect URLs if you enable OAuth. Set `providers`, `passkeys` and `mfa` in `src/config/auth.ts` only after enabling the corresponding methods in Motherbase. The sign in form shows MFA automatically when the server requires it, regardless of the `mfa` settings-panel option.

`src/proxy.ts` refreshes the session on Node.js. `src/lib/motherbase/server.ts` creates the server client, and the protected `/app` layout verifies the user with `auth.getSession()`, which asks the server. Keep server-side authorization when adding protected pages or data access.

Run `npm run typecheck` and `npm run build` before deploying. Start building your product in `src/app/(protected)/app/page.tsx`.
