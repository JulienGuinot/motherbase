// Which Supabase connection string the importer actually needs.
//
// Supabase exposes three URIs for the same database and only one of them works
// for a full import:
//
//   Direct        db.<ref>.supabase.co:5432        AAAA-only since the IPv4
//                                                  deprecation, so a host
//                                                  without IPv6 egress fails
//                                                  with ENOTFOUND.
//   Transaction   ...pooler.supabase.com:6543      No session state, so pg_dump
//                                                  (used for schema + data)
//                                                  cannot run against it.
//   Session       ...pooler.supabase.com:5432      IPv4 + full session support.
//                                                  This is the one to paste.
//
// These helpers turn that into inline guidance instead of a failed import.

export const SUPABASE_CONN_PLACEHOLDER =
  'postgresql://postgres.[ref]:[password]@aws-1-[region].pooler.supabase.com:5432/postgres';

export const SUPABASE_CONN_HINT =
  'Connect → Session pooler (port 5432). The direct db.[ref].supabase.co URI is IPv6-only and the 6543 transaction pooler cannot be dumped. Used once, never stored.';

// Three parts of a Supabase project are not in its database, so the connection
// string cannot reach them. Each needs its own credential, and each is optional:
// leave one out and that section reports what it could not read.

export const SUPABASE_SERVICE_KEY_HINT =
  'The service_role key from the project API keys page. Needed to download the bytes behind each storage object; without it the buckets are still recreated. Used once, never stored.';

export const SUPABASE_MANAGEMENT_TOKEN_HINT =
  'Edge functions and project secrets are held by Supabase, not by your database, so reading them needs a personal access token. Used once, never stored.';

export type SupabaseConnIssue = { level: 'error' | 'warn'; message: string };

/**
 * Inspect a pasted Supabase URI and return the problems that would make the
 * import fail (or half-fail) before it is sent to the server.
 */
export function inspectSupabaseConn(raw: string): SupabaseConnIssue[] {
  const value = raw.trim();
  if (!value) return [];

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [{ level: 'error', message: 'Not a valid URL. Expected postgresql://user:password@host:5432/postgres' }];
  }
  if (!/^postgres(ql)?:$/i.test(url.protocol)) {
    return [{ level: 'error', message: 'Must start with postgres:// or postgresql://' }];
  }

  const issues: SupabaseConnIssue[] = [];
  const host = url.hostname.toLowerCase();
  const port = url.port || '5432';
  const user = decodeURIComponent(url.username || '');

  if (/^db\..+\.supabase\.co$/.test(host)) {
    issues.push({
      level: 'error',
      message:
        'Direct connection host (db.[ref].supabase.co) resolves over IPv6 only and will fail with ENOTFOUND. Use the Session pooler URI instead.',
    });
  } else if (host.endsWith('pooler.supabase.com')) {
    if (port === '6543') {
      issues.push({
        level: 'error',
        message: 'Port 6543 is the transaction pooler: pg_dump cannot run there, so schema and data would be skipped. Use port 5432 (session pooler).',
      });
    }
    if (user && !user.includes('.')) {
      issues.push({
        level: 'warn',
        message: 'Pooler connections use the user postgres.[project-ref], not plain postgres.',
      });
    }
  }

  if (!url.password) {
    issues.push({ level: 'warn', message: 'No password in the URI. Replace [password] with the database password.' });
  }
  if (!url.pathname || url.pathname === '/') {
    issues.push({ level: 'warn', message: 'No database name. Append /postgres to the URI.' });
  }

  return issues;
}

/** True when nothing blocks the import (warnings are allowed through). */
export function supabaseConnIsUsable(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  return !inspectSupabaseConn(value).some(i => i.level === 'error');
}

// Where each credential is actually created. The two project-scoped links
// deep-link to the source project as soon as the pasted URI names it.

export const SUPABASE_TOKENS_URL = 'https://supabase.com/dashboard/account/tokens';

/** The project ref out of a pasted URI, tolerant of a half-typed one. */
export function supabaseRefFromConn(raw: string): string | null {
  const value = String(raw ?? '').trim();
  const pooled = /postgres\.([a-z0-9]{16,32})[:@]/i.exec(value);
  if (pooled) return pooled[1].toLowerCase();
  const direct = /@db\.([a-z0-9]{16,32})\.supabase\.(?:co|red)/i.exec(value);
  return direct ? direct[1].toLowerCase() : null;
}

/** Dashboard page holding the connection string, project-scoped when known. */
export function supabaseConnectUrl(conn: string): string {
  const ref = supabaseRefFromConn(conn);
  return ref ? `https://supabase.com/dashboard/project/${ref}?showConnect=true` : 'https://supabase.com/dashboard/projects';
}

/** Dashboard page holding the service_role key, project-scoped when known. */
export function supabaseApiKeysUrl(conn: string): string {
  const ref = supabaseRefFromConn(conn);
  return ref
    ? `https://supabase.com/dashboard/project/${ref}/settings/api-keys`
    : 'https://supabase.com/dashboard/projects';
}
