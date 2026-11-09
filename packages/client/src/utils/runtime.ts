/**
 * Whether this runs in a browser page.
 *
 * `window` alone is not the test: React Native defines it too, with no
 * `location` or `history`, and a fetch that sends no Origin while still
 * replaying the session cookie from its native jar. Taking it for a browser
 * meant no Origin on a cookie-carrying mutation (`403 Missing or null Origin`
 * on sign-out) and a crash reading `window.location.href`. A page has a
 * `document`; React Native, Node and Deno do not.
 * @internal
 */
export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}
