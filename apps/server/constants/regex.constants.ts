export const emailRegex = /^[\w.-]+@[a-zA-Z\d.-]+\.[a-zA-Z]{2,}$/;

/** Tables the admin surfaces never expose: Prisma internals and Postgres catalogs. */
export const INTERNAL_TABLE_RE = /^(_prisma_|pg_)/i;

/** Slug used for project names, containers and generated hostnames. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
