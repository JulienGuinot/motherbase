import { describe, expect, it } from 'vitest';
import { makeCatalogSnapshot } from '../services/rest-api/catalog';
import { assertTableProfile, exposedRpcSchemas, resolveRpcSchema } from '../services/rest-api/rest-model';
import { assertQueueName, exposeStatements, permissionStatements } from '../services/admin/queue.service';

const withPgmqPublic = makeCatalogSnapshot({
  functions: [
    { schema: 'public', name: 'rpc_add' },
    { schema: 'pgmq_public', name: 'send' },
  ],
});
const publicOnly = makeCatalogSnapshot({ functions: [{ schema: 'public', name: 'rpc_add' }] });

describe('rpc schema profiles', () => {
  it('serves pgmq_public only while the schema exists', () => {
    expect(exposedRpcSchemas(withPgmqPublic)).toEqual(['public', 'pgmq_public']);
    expect(exposedRpcSchemas(publicOnly)).toEqual(['public']);
  });

  it('defaults to public and refuses a schema that is not exposed, with PostgREST\'s code', () => {
    expect(resolveRpcSchema(publicOnly, undefined)).toBe('public');
    expect(resolveRpcSchema(withPgmqPublic, 'pgmq_public')).toBe('pgmq_public');
    expect(() => resolveRpcSchema(publicOnly, 'pgmq_public')).toThrow(
      expect.objectContaining({ statusCode: 406, code: 'PGRST106' }),
    );
    // A platform schema is never reachable, whatever exists in it.
    expect(() => resolveRpcSchema(withPgmqPublic, 'auth')).toThrow(/public, pgmq_public/);
  });

  it('keeps tables on public whatever the profile header says', () => {
    expect(() => assertTableProfile(undefined)).not.toThrow();
    expect(() => assertTableProfile('public')).not.toThrow();
    expect(() => assertTableProfile('pgmq_public')).toThrow(expect.objectContaining({ statusCode: 406 }));
  });
});

describe('queue SQL', () => {
  it('accepts only names pgmq would store unchanged', () => {
    expect(assertQueueName('jobs_2')).toBe('jobs_2');
    for (const bad of ['Jobs', '2jobs', 'a-b', 'x'.repeat(48), 'q"; drop', '']) {
      expect(() => assertQueueName(bad), bad).toThrow(expect.objectContaining({ statusCode: 400 }));
    }
  });

  it('grants and revokes exactly the difference, on the queue and its archive', () => {
    expect(permissionStatements('jobs', 'anon', { select: true, insert: true, update: false, delete: false })).toEqual([
      'GRANT SELECT, INSERT ON pgmq."q_jobs", pgmq."a_jobs" TO anon',
      'REVOKE UPDATE, DELETE ON pgmq."q_jobs", pgmq."a_jobs" FROM anon',
    ]);
    expect(permissionStatements('jobs', 'authenticated', { select: true, insert: true, update: true, delete: true }))
      .toEqual(['GRANT SELECT, INSERT, UPDATE, DELETE ON pgmq."q_jobs", pgmq."a_jobs" TO authenticated']);
  });

  it('revokes PUBLIC execute before granting the API roles', () => {
    const statements = exposeStatements(true);
    const revoke = statements.indexOf('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq_public FROM PUBLIC');
    const grant = statements.findIndex(s => s.startsWith('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq_public'));
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
    expect(exposeStatements(false)[0]).toBe('DROP SCHEMA IF EXISTS pgmq_public CASCADE');
  });
});
