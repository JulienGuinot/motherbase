'use client';

import type { QueryClient } from '@tanstack/react-query';

/**
 * What each business operation invalidates, in one place.
 *
 * Every mutation used to name its own key, and the ones it forgot stayed on
 * screen: revoking a user's sessions refreshed `users` but not `user-detail` or
 * the global `project-sessions` list, so the revoked sessions were still listed;
 * revoking from the Sessions page refreshed only that page and the drawer
 * refreshed only itself; applying a migration refreshed the migration list and
 * nothing it had just changed; rescheduling an edge function refreshed the
 * function list and not the job list its schedule appears in.
 *
 * One map, so adding a screen that reads an affected query is a one-line change
 * here rather than an omission nobody notices until the data is wrong.
 */
const AFFECTED: Record<string, string[][]> = {
  /** Promote, demote, delete, create, reset password. */
  'user.changed': [['users'], ['user-detail'], ['project-sessions']],
  /** Any revoke, from anywhere: the user list, the drawer, the sessions page. */
  'session.revoked': [['users'], ['user-detail'], ['project-sessions']],
  /**
   * DDL ran. Everything that describes the shape of the database is now
   * potentially wrong, including rows already fetched from a table whose
   * columns just changed.
   */
  'schema.changed': [
    ['migrations'],
    ['tables'],
    ['rows'],
    ['schema-tables'],
    ['schema-tables-api'],
    ['rest-resources'],
    ['schema-graph'],
    ['pg-triggers'],
    ['pg-functions'],
    ['api-policies'],
    ['rls-tables'],
    ['rls-access'],
    ['stats'],
    // Database section: sizes, indexes, enum types, grants and publications.
    ['db-table-stats'],
    ['db-indexes'],
    ['db-enums'],
    ['db-column-privileges'],
    ['db-publications'],
  ],
  /** A function's code, route, enabled flag or schedule changed. */
  'edge-function.changed': [['edge-functions'], ['cron-app-jobs'], ['app-job-runs']],
  /** A bucket or its files changed. */
  'storage.changed': [['storage-buckets'], ['storage-files'], ['bucket-deletions']],
  /** A backup was created, restored or extracted. */
  'backup.changed': [['backups-list'], ['backups-config']],
};

export type InvalidationEvent = keyof typeof AFFECTED;

/**
 * Arbitrary SQL ran: the SQL editor, or a tool call of the AI assistant. Unlike
 * the events above it can have changed anything the database holds (a schema
 * object, any table's rows, a role or a grant, a cron job, a queue, a vault
 * secret, a bucket, a user), so no list of keys is right. A list is how the
 * editor came to refresh three caches after a CREATE TABLE and none after a
 * CREATE FUNCTION. Everything is marked stale; only what is on screen refetches.
 */
export function invalidateAfterArbitrarySql(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries();
}

/**
 * Invalidate everything one operation can have made stale.
 *
 * Keys are matched by prefix, which is how `['rows']` reaches every
 * `['rows', model, page, …]` entry in the cache.
 */
export function invalidateFor(qc: QueryClient, event: InvalidationEvent): Promise<void> {
  return Promise.all(
    (AFFECTED[event] ?? []).map(queryKey => qc.invalidateQueries({ queryKey })),
  ).then(() => undefined);
}
