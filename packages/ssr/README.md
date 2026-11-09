# @motherbase/ssr

Next.js support for [`@motherbase/client`](https://www.npmjs.com/package/@motherbase/client):
a browser client that persists the session to a cookie, a server client that
reads it, and the middleware helper that refreshes it.

```bash
npm install @motherbase/client @motherbase/ssr
```

## The three pieces, and why all three are required

A Next.js app needs the session in two runtimes: the browser, and the server
that renders your Server Components. A cookie is the only thing both can see.
Only one place is allowed to write it.

| Where | Use | Writes the cookie? |
| --- | --- | --- |
| Client Components | `createBrowserClient` | yes, via `document.cookie` |
| Server Components, Route Handlers, Server Actions | `createServerClient` | no (Next.js forbids it in Server Components) |
| `proxy.ts` / `middleware.ts` | `updateSession` | yes, this is the one that keeps it fresh |

Skipping `updateSession` is the single most common setup mistake, and it is
silent: nothing throws, no `Authorization` header is ever attached, and
`auth.getSession()` returns `null` on both sides. In development the SDK now warns
on the console when it detects a session it could not write. In production it
stays quiet, so set the middleware up.

Do not use `createClient` from `@motherbase/client` directly in a Next.js app:
it stores the session in memory, which the server cannot read and a reload
destroys.

## Setup

```ts
// lib/client.ts  (Client Components)
import { createBrowserClient } from '@motherbase/ssr'
import type { Database } from './database.types' // motherbase gen types typescript

export function browserClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_MOTHERBASE_URL!,
    process.env.NEXT_PUBLIC_MOTHERBASE_KEY!,
  )
}
```

```ts
// lib/server.ts  (Server Components, Route Handlers, Server Actions)
import { cookies } from 'next/headers'
import { createServerClient } from '@motherbase/ssr'
import type { Database } from './database.types'

export async function serverClient() {
  const store = await cookies()
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_MOTHERBASE_URL!,
    process.env.NEXT_PUBLIC_MOTHERBASE_KEY!,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (list) => {
          for (const { name, value, options } of list) store.set(name, value, options)
        },
      },
    },
  )
}
```

```ts
// proxy.ts on Next.js 16+, middleware.ts on Next.js 14 and 15.
// Same body either way; only the filename and the exported name differ.
import type { NextRequest } from 'next/server'
import { updateSession } from '@motherbase/ssr'

export async function proxy(request: NextRequest) {
  return updateSession(
    request,
    process.env.NEXT_PUBLIC_MOTHERBASE_URL!,
    process.env.NEXT_PUBLIC_MOTHERBASE_KEY!,
  )
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```

`updateSession` never throws: if the backend is unreachable it leaves the
existing cookie in place and the navigation proceeds.

## Changing the cookie name

`SESSION_COOKIE_KEY` (`motherbase.session`) is the default. If you override it,
override it in all three places, or the half that reads a name nobody writes
will report the user as logged out:

```ts
createBrowserClient(url, key, { cookieKey: 'my-app.session' })
createServerClient(url, key, { cookies, cookieKey: 'my-app.session' })
updateSession(request, url, key, { cookieKey: 'my-app.session' })
```

## Entry points

`@motherbase/ssr` is the main entry. The three modules are also addressable
individually (`@motherbase/ssr/browser`, `/server`, `/middleware`) when you want
to keep `next/server` out of a client bundle.

## Compatibility

`next >= 14`, App Router. Types are checked against Next 15; the API used here
(`NextRequest`, `NextResponse`, `cookies()`) is unchanged on Next 16, where the
`middleware.ts` convention is deprecated in favour of `proxy.ts`.
