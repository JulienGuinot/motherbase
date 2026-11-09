# __APP_NAME__

React + Vite starter with Motherbase authentication.

1. Copy `.env.example` to `.env.local`.
2. Set `VITE_MOTHERBASE_URL` and `VITE_MOTHERBASE_KEY` to your project's API URL and public key. Never use an admin or secret key here.
3. Run `npm run dev`, then open `http://localhost:5173`.

Add `http://localhost:5173/auth/callback` to your project's allowed Auth redirect URLs if you enable OAuth. Set `providers`, `passkeys` and `mfa` in `src/config/auth.ts` only after enabling the corresponding methods in Motherbase. The sign in form shows MFA automatically when the server requires it, regardless of the `mfa` settings-panel option.

The React route guard improves navigation; it is not an authorization boundary. Motherbase must enforce access on every API request. When deploying, configure your host to serve `index.html` for client-side routes such as `/auth/callback` and `/app`.

Run `npm run typecheck` and `npm run build` before deploying. Start building your product in `src/app.tsx`.
