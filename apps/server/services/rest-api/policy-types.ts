/**
 * Defence in depth, not the primary control.
 *
 * The primary control is that the REST API only ever exposes the `public`
 * schema, while every Motherbase-managed table lives in `auth`, `storage` or
 * `platform`. This list stays as a second, name-based gate so that a user table
 * created in `public` under one of these names cannot be reached over REST
 * either. Both the Prisma model names (historical callers, e.g.
 * `RealtimeAdminService`) and the physical table names are listed, because a
 * catalog-driven REST layer resolves by physical name.
 */
const REST_BLOCKED_MODELS = new Set([
  // Better Auth internal tables: never exposed through the REST API.
  'Session',
  'Account',
  'Verification',
  'Jwks',
  'AppSetting',
  'Trigger',
  'EdgeFunctionSecret',
  'SchemaMigration',
  'RealtimeOutbox',
  // Physical table names for the same set (`@@map` targets in schema.prisma).
  'session',
  'account',
  'verification',
  'jwks',
  'app_settings',
  'edge_function_secrets',
  'schema_migrations',
  'realtime_outbox',
]);

export function isRestBlockedModel(model: string): boolean {
  return REST_BLOCKED_MODELS.has(model);
}
