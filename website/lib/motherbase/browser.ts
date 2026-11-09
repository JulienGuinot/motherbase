import { createBrowserClient } from '@motherbase/ssr'
import type { MotherbaseClient } from '@motherbase/ssr'
import { cookieStorage } from '@motherbase/client'

let client: MotherbaseClient | undefined

/**
 * The SDK's `serverCookieStorage` hands an already-URI-encoded value to
 * `NextResponse.cookies.set`, which encodes again — so any cookie written by
 * the middleware is double-encoded and the browser adapter's single
 * `decodeURIComponent` leaves unparseable JSON. Decode until it parses.
 */
function tolerantCookieStorage() {
  const inner = cookieStorage()
  return {
    ...inner,
    get: () => {
      const parsed = inner.get()
      if (parsed) return parsed
      const raw = document.cookie.match(/(?:^|; )motherbase\.session=([^;]*)/)?.[1]
      if (!raw) return null
      let value = raw
      for (let i = 0; i < 3; i++) {
        try {
          return JSON.parse(value)
        } catch {
          value = decodeURIComponent(value)
        }
      }
      return null
    },
  }
}

/** Singleton Motherbase client for Client Components. Session persists via cookie. */
export function getBrowserClient(): MotherbaseClient {
  const url = process.env.NEXT_PUBLIC_MOTHERBASE_URL
  if (!url) throw new Error('NEXT_PUBLIC_MOTHERBASE_URL is not set')

  client ??= createBrowserClient(url, undefined, { storage: tolerantCookieStorage() })
  return client
}
