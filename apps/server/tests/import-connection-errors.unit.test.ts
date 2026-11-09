import { describe, expect, it } from 'vitest';
import { describeImportFailure, redactConnectionSecrets } from '../services/admin/import.service';

// A Supabase import that fails must say WHICH thing is wrong. Before this, a
// hostname typo reached the Studio as a bare 500 "getaddrinfo ENOTFOUND
// db.xxx.supabase.co", which reads as "the importer is broken".

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
const dnsError = (code: string, hostname: string) =>
  Object.assign(new Error(`getaddrinfo ${code} ${hostname}`), { code, hostname });

describe('describeImportFailure', () => {
  it('names an unresolvable host and points at the pooler for a Supabase direct URI', () => {
    const { status, message } = describeImportFailure(dnsError('ENOTFOUND', 'db.abcdefg.supabase.co'));

    expect(status).toBe(502);
    expect(message).toContain('db.abcdefg.supabase.co');
    expect(message).toContain('could not be resolved');
    expect(message).toContain('Session pooler');
  });

  it('does not push the pooler hint at a host that is not a Supabase direct connection', () => {
    const { message } = describeImportFailure(dnsError('ENOTFOUND', 'db.internal.example.com'));

    expect(message).toContain('db.internal.example.com');
    expect(message).not.toContain('Session pooler');
  });

  it('separates a refused connection from an unresolvable one', () => {
    const { status, message } = describeImportFailure(
      Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED', hostname: '10.0.0.1' }),
    );

    expect(status).toBe(502);
    expect(message).toContain('refused the connection');
  });

  it('reports an IPv6-only host as unreachable, not as a bad hostname', () => {
    const { status, message } = describeImportFailure(
      Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' }),
    );

    expect(status).toBe(502);
    expect(message).toContain('not reachable');
    expect(message).toContain('IPv6-only');
  });

  it('reports a timeout as a timeout', () => {
    const { status, message } = describeImportFailure(pgError('ETIMEDOUT', 'connect ETIMEDOUT'));

    expect(status).toBe(504);
    expect(message).toContain('timed out');
  });

  it('reports rejected credentials as a client error, not a server fault', () => {
    const { status, message } = describeImportFailure(pgError('28P01', 'password authentication failed for user "postgres"'));

    expect(status).toBe(400);
    expect(message).toContain('password was rejected');
  });

  it('distinguishes a refused user or client address from a wrong password', () => {
    const { status, message } = describeImportFailure(
      pgError('28000', 'no pg_hba.conf entry for host "203.0.113.9"'),
    );

    expect(status).toBe(400);
    expect(message).toContain('refused this user');
  });

  it('names an unknown database rather than blaming the credentials', () => {
    const { status, message } = describeImportFailure(pgError('3D000', 'database "postgress" does not exist'));

    expect(status).toBe(400);
    expect(message).toContain('does not exist');
    expect(message).toContain('postgres');
  });

  it('reports an exhausted connection pool as retryable', () => {
    const { status } = describeImportFailure(pgError('53300', 'sorry, too many clients already'));

    expect(status).toBe(503);
  });

  it('reports an unreadable source schema as a privilege problem', () => {
    const { status, message } = describeImportFailure(pgError('42501', 'permission denied for schema public'));

    expect(status).toBe(403);
    expect(message).toContain('read the source objects');
  });

  it('recognises the transaction pooler, which pg_dump cannot use', () => {
    const { status, message } = describeImportFailure(new Error('unnamed prepared statement does not exist'));

    expect(status).toBe(400);
    expect(message).toContain('6543');
  });

  it('falls back to a scrubbed message for a cause it does not recognise', () => {
    const { status, message } = describeImportFailure(
      new Error('connection to postgresql://postgres:hunter2@db.abc.supabase.co:5432/postgres died'),
    );

    expect(status).toBe(502);
    expect(message).not.toContain('hunter2');
    expect(message).toContain('***');
  });

  // The whole point of the mapper is defeated if it hands the password back.
  it.each([
    dnsError('ENOTFOUND', 'db.abc.supabase.co'),
    pgError('28P01', 'password authentication failed'),
    pgError('42P01', 'relation "postgresql://postgres:hunter2@host/db" does not exist'),
    new Error('postgres://admin:hunter2@example.com:5432/app is unreachable'),
  ])('never leaks the password (case %#)', error => {
    expect(describeImportFailure(error).message).not.toContain('hunter2');
  });
});

describe('redactConnectionSecrets', () => {
  it('masks the password in a URI and in a key=value connection string', () => {
    expect(redactConnectionSecrets('postgresql://postgres:hunter2@db.abc.supabase.co:5432/postgres')).toBe(
      'postgresql://postgres:***@db.abc.supabase.co:5432/postgres',
    );
    expect(redactConnectionSecrets('host=db.abc.supabase.co password=hunter2 dbname=postgres')).toBe(
      'host=db.abc.supabase.co password=*** dbname=postgres',
    );
  });

  it('leaves a message with no secret in it untouched', () => {
    expect(redactConnectionSecrets('relation "todos" does not exist')).toBe('relation "todos" does not exist');
  });
});
