import { describe, it, expect } from 'vitest';
import { runCommand, toLibpqUrl } from '../services/admin/pg-command';
import { ApplicationError } from '../exceptions/application-error';
import { normalizeApiError } from '../middlewares/api-error.middleware';

// ── toLibpqUrl ───────────────────────────────────────────────────────────────
// Prisma appends query params (schema, pgbouncer, …) that libpq rejects with
// "invalid URI query parameter". toLibpqUrl must strip those while keeping
// everything libpq understands.

describe('toLibpqUrl', () => {
  it('strips the Prisma ?schema= param that libpq rejects', () => {
    const out = toLibpqUrl('postgresql://u:p@localhost:5432/app?schema=public');
    expect(out).not.toContain('schema');
    expect(out).toContain('postgresql://u:p@localhost:5432/app');
  });

  it('strips all non-libpq params but keeps libpq ones (sslmode)', () => {
    const out = toLibpqUrl(
      'postgresql://u:p@localhost:5432/app?schema=public&pgbouncer=true&connection_limit=5&sslmode=require'
    );
    expect(out).not.toMatch(/schema|pgbouncer|connection_limit/);
    expect(out).toContain('sslmode=require');
  });

  it('leaves a plain URL with no query params unchanged', () => {
    const url = 'postgresql://u:p@localhost:5432/app';
    expect(toLibpqUrl(url)).toBe(url);
  });

  it('returns unparseable input unchanged', () => {
    expect(toLibpqUrl('not a url')).toBe('not a url');
  });
});

// ── runCommand error exposure ────────────────────────────────────────────────
// pg_dump/psql failures (missing binary, version mismatch, nonzero exit) carry
// operator-actionable, argument-free messages. They must reach the operator
// instead of being masked as a generic "Internal server error" by the 500 rule.

describe('runCommand error exposure', () => {
  it('rejects with an actionable, exposable error when the tool is missing', async () => {
    // A binary guaranteed not to exist triggers the ENOENT branch.
    const err = await runCommand('motherbase-no-such-binary-xyz', []).catch(e => e);

    expect(err).toBeInstanceOf(ApplicationError);
    expect(err.statusCode).toBe(500);
    // The crafted message is operator guidance: it must be marked exposable so
    // it survives the production error middleware.
    expect(err.expose).toBe(true);
    expect(err.message).toMatch(/not found/i);
  });

  it('surfaces the actionable message through the production error middleware', async () => {
    const err = await runCommand('motherbase-no-such-binary-xyz', []).catch(e => e);

    const normalized = normalizeApiError(err, /* isProduction */ true);

    // Before the fix this collapsed to the generic "Internal server error".
    expect(normalized.body.message).toMatch(/not found/i);
    expect(normalized.body.message).not.toBe('Internal server error');
  });
});
