/**
 * Public origin of this project's API. `.localhost` hosts are the dev stack
 * behind the local Traefik: HTTP only, even though the image runs with
 * NODE_ENV=production. Getting this wrong makes Better Auth issue `Secure`
 * cookies the browser drops on plain http (sign-up 200s, no session).
 */
export function resolveBaseUrl(host: string, isProduction: boolean): string {
  const isLocal = /(^|\.)localhost(:|$)|^127\.0\.0\.1(:|$)|^\[::1\](:|$)/.test(host);
  return `${isProduction && !isLocal ? 'https' : 'http'}://${host}`;
}

// ponytail: last-two-labels stands in for the public suffix list. It is wrong
// for multi-label suffixes (api.example.co.uk and app.other.co.uk both read as
// "co.uk"), which under-applies SameSite=None and leaves that deployment with
// the original state_mismatch. Pull in `tldts` if anyone actually hits it.
/** Registrable-domain approximation: the last two labels of a host. */
function siteOf(host: string): string {
  return host.split(':')[0].toLowerCase().split('.').slice(-2).join('.');
}

/**
 * Extra cookie attributes needed when the frontend lives on another site.
 *
 * Better Auth's cookies default to `SameSite=Lax`, and a browser refuses to
 * store a Lax cookie that arrives on a cross-site XHR response. `POST
 * /sign-in/social` is exactly that call for an app on another domain, so the
 * OAuth state cookie was dropped and every provider callback came back as
 * `?error=state_mismatch`: the sign-in looked like it worked right up to the
 * redirect. `SameSite=None` fixes it, but a browser also rejects `None` without
 * `Secure`, so this only applies over https; a plain-http dev stack keeps Lax
 * (and is same-site anyway).
 *
 * Returns undefined when every trusted origin is same-site, which keeps the
 * stricter default for the common single-domain deployment.
 */
export function crossSiteCookieAttributes(
  baseURL: string,
  trustedOrigins: string[],
): { sameSite: 'none'; secure: true } | undefined {
  if (!baseURL.startsWith('https://')) return undefined;
  let site: string;
  try {
    site = siteOf(new URL(baseURL).host);
  } catch {
    return undefined;
  }
  const crossSite = trustedOrigins.some(origin => {
    if (origin === '*') return true;
    try {
      return siteOf(new URL(origin).host) !== site;
    } catch {
      return false;
    }
  });
  return crossSite ? { sameSite: 'none', secure: true } : undefined;
}
