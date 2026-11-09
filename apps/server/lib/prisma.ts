// Single shared PrismaClient instance for the whole app.
// Registered in the awilix container as `prisma` (see models/index.ts).
import { PrismaClient } from '@prisma/client';
import { APPLICATION_NAME } from './instance';

/**
 * Tag the control-plane connections with this process's id.
 *
 * The RlsPool is tagged too, but it is lazy and lets idle clients expire, so an
 * instance serving no data-plane traffic would drop off `pg_stat_activity`
 * entirely and the replica count in the Shield report would under-report. Prisma
 * holds its pool for the process lifetime, so tagging it here is what makes the
 * count reflect running instances rather than busy ones. See lib/instance.ts.
 *
 * Left untouched when the URL already names one (an operator who set it meant
 * it) or cannot be parsed: a diagnostic must never be the reason boot fails.
 */
export function taggedDatabaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    if (url.searchParams.has('application_name')) return raw;
    url.searchParams.set('application_name', APPLICATION_NAME);
    return url.toString();
  } catch {
    return raw;
  }
}

const url = taggedDatabaseUrl(process.env.DATABASE_URL);

const prisma = url
  ? new PrismaClient({ datasources: { db: { url } } })
  : new PrismaClient();

export default prisma;
export type { PrismaClient };
