// Supabase's URL Configuration: a Site URL plus an allowlist of redirect URLs,
// with GoTrue's glob wildcards.
//
// Every redirect an auth flow ends in (OAuth and SSO callbacks, magic links,
// email verification, password recovery) is checked against it. A redirect
// that is not allowed falls back to the Site URL, which is what GoTrue does,
// rather than failing the sign-in the user already completed.
//
// Wildcards follow GoTrue (gobwas/glob with `.` and `/` as separators):
//   `*`  any run of characters except `.` and `/`   https://*.example.com
//   `**` any run of characters at all               http://localhost:3000/**
//   `?`  one character except `.` and `/`

export interface RedirectConfig {
  /** Default redirect, and always allowed along with anything under it. */
  siteUrl: string;
  /** GoTrue globs, matched against the whole URL. */
  allowList: string[];
}

/** PKCE rides on the redirect URL (see auth/pkce.ts); it is not part of what an operator allowlists. */
export const PKCE_PARAMS = ['code_challenge', 'code_challenge_method'] as const;

export function compileRedirectPattern(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      source += '.*';
      i += 1;
    } else if (char === '*') {
      source += '[^./]*';
    } else if (char === '?') {
      source += '[^./]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/** The URL as matched: PKCE parameters removed, nothing else normalised. */
function withoutPkceParams(url: URL): string {
  const copy = new URL(url.href);
  for (const param of PKCE_PARAMS) copy.searchParams.delete(param);
  return copy.href;
}

/** True when the operator has configured anything at all. Unconfigured means "not enforced". */
export function redirectsConfigured(config: RedirectConfig | undefined): config is RedirectConfig {
  return !!config && (!!config.siteUrl || config.allowList.length > 0);
}

export function isAllowedRedirect(target: string, config: RedirectConfig): boolean {
  // A path on the API's own origin cannot leave it.
  if (target.startsWith('/') && !target.startsWith('//') && !target.startsWith('/\\')) return true;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.protocol === 'javascript:' || url.protocol === 'data:') return false;
  if (config.siteUrl) {
    try {
      // The Site URL itself and anything under its path, on its exact origin.
      const site = new URL(config.siteUrl);
      const base = site.pathname.endsWith('/') ? site.pathname : `${site.pathname}/`;
      if (url.origin === site.origin && (url.pathname === site.pathname || url.pathname.startsWith(base))) return true;
    } catch {
      /* an invalid Site URL allows nothing extra */
    }
  }
  const candidate = withoutPkceParams(url);
  return config.allowList.some(pattern => compileRedirectPattern(pattern).test(candidate));
}

/** The redirect to use: the one asked for when allowed, else the Site URL. */
export function resolveRedirect(target: string | undefined, config: RedirectConfig): string | undefined {
  if (target === undefined || target === '') return config.siteUrl || undefined;
  return isAllowedRedirect(target, config) ? target : config.siteUrl || '/';
}

/**
 * The origins behind the Site URL and the allowlist, for Better Auth's
 * `trustedOrigins`. Better Auth checks a callback URL's origin before our
 * hook ever sees it, so an allowlisted app must be a trusted origin too.
 * `*` in a host survives as Better Auth's own origin wildcard; a pattern with
 * a wildcard in its scheme or port contributes nothing (too broad to trust).
 */
export function redirectOrigins(config: RedirectConfig): string[] {
  const origins = new Set<string>();
  for (const entry of [config.siteUrl, ...config.allowList]) {
    const match = /^(https?:\/\/[^/?#]+)/i.exec(entry ?? '');
    if (!match) continue;
    const origin = match[1].replace(/\*\*/g, '*');
    if (/^https?:\/\/[^:]*:\*/.test(origin)) continue;
    origins.add(origin);
  }
  return [...origins];
}

/** Every field a Better Auth endpoint takes a redirect in, body or query. */
export const REDIRECT_FIELDS = ['callbackURL', 'newUserCallbackURL', 'errorCallbackURL', 'redirectTo'] as const;

/** Flows that end in a browser redirect, where GoTrue defaults to the Site URL. */
export const DEFAULT_TO_SITE_URL_PATHS = ['/sign-in/social', '/sign-in/magic-link', '/sign-in/sso', '/link-social'];

/**
 * Rewrite the redirect fields of one request body or query so each one is
 * allowed. Returns the patched copy, or null when nothing had to change, so a
 * caller hands Better Auth a new context only when there is something in it.
 */
export function enforceRedirects(
  values: Record<string, unknown> | undefined,
  config: RedirectConfig,
  options: { defaultCallback?: boolean } = {},
): Record<string, unknown> | null {
  if (!values || typeof values !== 'object') return null;
  const patched: Record<string, unknown> = { ...values };
  let changed = false;
  for (const field of REDIRECT_FIELDS) {
    const value = values[field];
    if (typeof value !== 'string' || !value) continue;
    const resolved = resolveRedirect(value, config);
    if (resolved !== value) {
      patched[field] = resolved === undefined ? resolved : carryPkceParams(value, resolved);
      changed = true;
    }
  }
  if (options.defaultCallback && !values.callbackURL && config.siteUrl) {
    patched.callbackURL = config.siteUrl;
    changed = true;
  }
  return changed ? patched : null;
}

/**
 * A PKCE flow whose redirect fell back to the Site URL must still end in a
 * code: the challenge moves to the replacement URL with it.
 */
function carryPkceParams(original: string, replacement: string): string {
  let from: URL;
  let to: URL;
  try {
    from = new URL(original, 'http://relative.invalid');
    to = new URL(replacement, 'http://relative.invalid');
  } catch {
    return replacement;
  }
  const carried = PKCE_PARAMS.filter(param => from.searchParams.has(param));
  if (!carried.length) return replacement;
  for (const param of carried) to.searchParams.set(param, from.searchParams.get(param)!);
  return replacement.startsWith('/') ? `${to.pathname}${to.search}${to.hash}` : to.href;
}
