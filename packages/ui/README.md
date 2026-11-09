# @motherbase/ui

React components for Motherbase authentication. Use them as complete screens or
compose the smaller pieces. They accept a `@motherbase/client` instance; Next.js
apps should create that instance with `@motherbase/ssr`.

```bash
npm install @motherbase/client @motherbase/ui
# Next.js apps also need @motherbase/ssr
```

Import the default stylesheet once in your app:

```tsx
import '@motherbase/ui/styles.css';
```

## Login in Next.js

```tsx
'use client';

import { createBrowserClient } from '@motherbase/ssr';
import { LoginPage } from '@motherbase/ui';

const client = createBrowserClient(
  process.env.NEXT_PUBLIC_MOTHERBASE_URL!,
  process.env.NEXT_PUBLIC_MOTHERBASE_KEY!,
);

export default function Login() {
  return (
    <LoginPage
      client={client}
      providers={['google', 'github']}
      passkeys
      oauthRedirectTo="https://app.example.com/auth/callback"
      onSuccess={() => { window.location.assign('/app'); }}
      classNames={{ card: 'my-login-card', button: 'my-primary-button' }}
      slots={{ logo: <strong>My app</strong>, footer: <a href="/forgot-password">Forgot password?</a> }}
    />
  );
}
```

Use a stable client instance, created outside the component. `LoginPage` is a
Client Component. Configure the matching server client and `updateSession`
middleware as described in `@motherbase/ssr`. The `oauthRedirectTo` origin must
be allowed in the project's Auth settings.

On the callback route, render `<AuthCallback client={client} onSuccess={...} />`.
It completes implicit and PKCE redirects. The callback consumes and removes the
URL token or code, or waits for the SDK's automatic redirect handling if it
already consumed them.

## Components

| Flow | Components |
| --- | --- |
| Sign in | `LoginPage`, `LoginForm`, `OAuthButtons`, `PasskeyButton`, `MfaChallenge`, `AuthCallback` |
| Credentials | `SignUpForm`, `ForgotPasswordForm`, `ResetPasswordForm` |
| Session | `MotherbaseProvider`, `useAuth`, `useUser`, `UserButton` |
| Account | `UserProfileForm`, `PasskeyManager`, `MfaSettings`, `SecurityPanel` |

Pass an explicit `client` to standalone forms, or wrap the tree in
`MotherbaseProvider`. `UserButton` and `UserProfileForm` use the provider.
For Next.js, keep authorization in Server Components or route handlers using
`auth.getSession()`, which asks the server; `useUser()` is for display and is
based on the locally stored session.

The login form shows only the methods you pass: `password`, `providers`, and
`passkeys`. The backend must have those methods enabled. MFA is different: the
server's `twoFactorRedirect` response controls when the challenge appears.
Changing UI props cannot skip a required second factor. Whether a one-time
second-factor code goes out by email or SMS is the project's setting.

`MfaSettings` renders a QR code by default and accepts `renderQr(uri)` to
replace it.

## Customizing

### Your global CSS

The stylesheet reads your app's design tokens, so the components match your
`globals.css` with no extra setup. It uses the shadcn/ui names:

| Your token | Used for |
| --- | --- |
| `--background`, `--card`, `--muted` | page, card, and recessed surfaces |
| `--foreground`, `--muted-foreground` | text |
| `--border`, `--input` | dividers and field borders |
| `--primary`, `--primary-foreground` | primary buttons, links, accents |
| `--ring` | focus outlines |
| `--destructive` | errors |
| `--radius` | corner radius |

Any token you don't define falls back to the built-in palette, with a dark
variant under `prefers-color-scheme: dark`. Values must be complete colours
(`oklch(…)`, `#…`, `hsl(…)`), not the bare `222 47% 11%` triplets of older
shadcn themes. The font is inherited.

To change one component token without touching your app's, set its
`--mbui-*` name (`--mbui-accent`, `--mbui-surface`, `--mbui-radius`,
`--mbui-shadow`, `--mbui-font`...) on `.mbui`:

```css
.mbui { --mbui-accent: var(--brand); --mbui-shadow: none; }
```

### Classes

Every rule is in the `components` cascade layer. Your own CSS (unlayered) and
Tailwind utilities override it without `!important` or specificity tricks, so
you can restyle any `.mbui-*` class directly, or pass classes per element:

```tsx
<SignUpForm classNames={{ card: 'rounded-none shadow-none', button: 'bg-black', footer: 'text-xs' }} />
```

Forms accept `className` and `classNames` (`root`, `card`, `logo`, `header`,
`title`, `description`, `form`, `field`, `input`, `button`, `secondaryButton`,
`message`, `footer`), and `slots` (`logo`, `footer`). Keep element resets in
your own `globals.css` inside `@layer base` so they don't beat component
classes. Or omit the stylesheet and style everything yourself.

### Text

Every visible string is a `labels` entry. Pass only the ones you change; the
others keep their default. Messages that include a value are functions:

```tsx
<LoginForm labels={{
  title: 'Connexion', email: 'E-mail', password: 'Mot de passe', submit: 'Se connecter',
  continueWith: provider => `Continuer avec ${provider}`,
  mfa: { title: 'Vérifiez votre identité' },
}} />
<FilesUpload bucket="docs" labels={{ tooMany: max => `${max} fichiers maximum.` }} />
<SecurityPanel labels={{ passkeys: { title: 'Clés d’accès' }, mfa: { title: 'Double authentification' } }} />
```

Each component exports its label type (`LoginLabels`, `SignUpLabels`,
`MfaSettingsLabels`, `UploadLabels`...). Error messages returned by the server
are shown as received.

## Avatars

`UserAvatar` shows the user's image (`image`, `user_metadata.image` or
`imageUrl`) and falls back to a generated blobatar when there is none or it
fails to load. `UserButton` and `UserProfileForm` use it and forward an `avatar`
prop:

```tsx
<UserButton avatar={{ size: 36, fallback: name => <b>{name[0]}</b> }} showName={false} />
<UserAvatar user={user} src={customUrl} size={48} />   {/* src={null} forces the fallback */}
```

Shape: set `--mbui-avatar-radius` (default `50%`). `UserButton` also takes
`labels`, `classNames` (`trigger`, `avatar`, `name`, `panel`) and `children` for
extra menu entries; `UserProfileForm` takes `labels` and `avatar={false}`.

### Changing the picture

`AvatarUpload` uploads an image to a **public** bucket (`avatars` by default,
`<user id>/avatar`, replaced each time) and saves its URL as the user's `image`.
Pass `avatarUpload` to `UserProfileForm` to use it (`bucket`, `path`, `maxSize`,
`labels`...). The bucket must exist and allow the signed-in user to write.

### Custom menu lines

```tsx
<UserButton items={[
  { label: 'Billing', href: '/billing', icon: <CardIcon /> },
  { label: 'Help', onClick: openHelp },   // no href: rendered as a button
]} />
```

## File upload

`FileUpload` (one file) and `FilesUpload` (several, four at a time, with a status
per file) upload through `client.storage` as soon as files are chosen or dropped.
They take a `client` or inherit it from `MotherbaseProvider`.

```tsx
<FileUpload bucket="docs" accept="application/pdf" maxSize={5_000_000}
  path={file => `${userId}/${file.name}`} onUploaded={result => save(result.path)} />
<FilesUpload bucket="docs" accept="image/*" maxFiles={10} upsert onUploaded={results => refresh()} />
```

`accept` and `maxSize` are checked before anything is sent, including for dropped
files. Style with `classNames` (`dropzone`, `list`, `message`) or `labels`.

## Session gates

`SignedIn`, `SignedOut`, `AuthLoading` and `SignOutButton` read the provider.
`SignedIn` takes an optional `fallback`; the gates render nothing while the
session loads, so use `AuthLoading` for a skeleton. They only hide UI: keep
authorization on the server.

```tsx
<SignedIn fallback={<LoginPage client={client} />}><Dashboard /></SignedIn>
```

## Local preview

From the repository root, run `npm run ui:preview`, then open
`http://127.0.0.1:5174` in your browser. The gallery shows sign-in, sign-up,
password recovery, account, and security components. The controls switch themes,
OAuth buttons, and passkeys.
The gallery uses local mock responses; no Motherbase server is needed. Use
`demo@example.com` with any password for sign-in, or `mfa@example.com` and
`123456` to preview the second factor. Passkey registration still needs a real
WebAuthn backend.

### Test against a real Motherbase project

Copy `packages/ui/playground/.env.example` to
`packages/ui/playground/.env.local` and set `VITE_MOTHERBASE_URL` and
`VITE_MOTHERBASE_KEY` to your instance's API URL and **publishable** project key.
The `VITE_` values are visible in the browser: never use a secret or admin key.
Restart `npm run ui:preview` after changing the file. Without these variables,
the gallery stays in mock mode.

Enable only the methods available on that project with
`VITE_MOTHERBASE_PROVIDERS=google,github` and
`VITE_MOTHERBASE_PASSKEYS=true`. Sign-up, password reset, profile, MFA, and
passkey actions in live mode affect the real project. Use a test account and
save real MFA recovery codes.

Allow `http://127.0.0.1:5174` in the backend's CORS origins. For OAuth, also
allow `http://127.0.0.1:5174/` as an Auth redirect URL. Use this exact host when
opening the preview; `localhost` is a different origin.
