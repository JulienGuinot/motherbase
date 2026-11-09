import { describe, it, expect } from 'vitest';
import { formatSqlError, parsePgError, motherbaseHint } from '../lib/pg-error';

function prismaError(code: string, message: string): Error {
  return new Error(
    'Invalid `prisma.$executeRawUnsafe()` invocation:\n\n\n'
      + `Raw query failed. Code: \`${code}\`. Message: \`${message}\``,
  );
}

describe('parsePgError', () => {
  it('strips the Prisma wrapper and keeps ERROR / HINT / code', () => {
    const err = prismaError(
      '42804',
      'ERROR: column "user_id" is of type uuid but default expression is of type text\n'
        + 'HINT:  You will need to rewrite or cast the expression.',
    );
    const info = parsePgError(err);
    expect(info.code).toBe('42804');
    expect(info.message).toBe('column "user_id" is of type uuid but default expression is of type text');
    expect(formatSqlError(err)).not.toContain('executeRawUnsafe');
    expect(formatSqlError(err)).not.toContain('Raw query failed');
  });

  it('falls back to the raw message when there is no Postgres envelope', () => {
    expect(parsePgError(new Error('connection refused')).message).toBe('connection refused');
    expect(formatSqlError(new Error('connection refused'))).toBe('ERROR: connection refused');
  });

  it('renders DETAIL and HINT on their own lines', () => {
    const err = prismaError('23503', 'ERROR: insert violates foreign key\nDETAIL:  Key (a)=(1) is absent.');
    expect(formatSqlError(err).split('\n')[1]).toBe('DETAIL: Key (a)=(1) is absent.');
  });
});

describe('motherbaseHint', () => {
  it('explains the text/uuid mismatch a Supabase schema walks into', () => {
    const hint = motherbaseHint('42804', 'column "user_id" is of type uuid but expression is of type text');
    expect(hint).toContain('text');
    expect(hint).toContain('auth.users(id)');
  });

  it('points gen_random_bytes at pgcrypto', () => {
    expect(motherbaseHint('42883', 'function gen_random_bytes(integer) does not exist'))
      .toContain('pgcrypto');
  });

  it('explains the Supabase `extensions` schema qualifier', () => {
    expect(motherbaseHint('3F000', 'schema "extensions" does not exist')).toContain('public');
  });

  it('says nothing when it has nothing to add', () => {
    expect(motherbaseHint('42601', 'syntax error at or near ")"')).toBeUndefined();
  });

  it('overrides the generic Postgres hint, which is useless here', () => {
    const err = prismaError(
      '42804',
      'ERROR: foreign key constraint cannot be implemented\n'
        + 'DETAIL:  Key columns "user_id" and "id" are of incompatible types: uuid and text.\n'
        + 'HINT:  You will need to rewrite or cast the expression.',
    );
    expect(formatSqlError(err)).toContain('Better Auth');
    expect(formatSqlError(err)).not.toContain('rewrite or cast');
  });
});
