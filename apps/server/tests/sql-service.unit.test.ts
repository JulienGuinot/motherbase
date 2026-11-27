import { describe, it, expect } from 'vitest';
import { SqlService, redactSqlSecrets, type SqlMode } from '../services/admin/sql.service';
import { env } from '../config/env';

const RO: SqlMode = { enabled: true, readonly: true };
const RW: SqlMode = { enabled: true, readonly: false };

function service(rows: any[] = [], affected = 0) {
  const calls: any = {};
  const fakePrisma: any = {
    $queryRawUnsafe: async (sql: string) => {
      calls.query = sql;
      return rows;
    },
    $executeRawUnsafe: async (sql: string) => {
      calls.execute = sql;
      return affected;
    },
    // Interactive transaction used by read-only execution.
    $transaction: async (fn: (tx: any) => any) => fn(fakePrisma),
  };
  const logBuffer = {
    pushed: [] as any[],
    push(e: any) {
      this.pushed.push(e);
    },
  };
  return { svc: new SqlService({ prisma: fakePrisma, logBuffer } as any), calls, logBuffer };
}

describe('SqlService.execute', () => {
  it('runs a read and returns columns + rows', async () => {
    const { svc, calls } = service([{ id: 1, email: 'a@b.c' }]);
    const res = await svc.execute('SELECT id, email FROM users', RO);
    expect(res.kind).toBe('read');
    expect(res.columns).toEqual(['id', 'email']);
    expect(res.rows).toHaveLength(1);
    expect(calls.query).toContain('SELECT');
  });

  it('serializes BigInt values so the result is JSON-safe', async () => {
    const { svc } = service([{ count: BigInt(10) }]);
    const res = await svc.execute('SELECT count(*) FROM users', RO);
    expect(res.rows![0].count).toBe('10');
    expect(() => JSON.stringify(res)).not.toThrow();
  });

  it('serializes Date values as ISO strings instead of empty objects', async () => {
    const createdAt = new Date('2026-06-10T10:11:12.000Z');
    const { svc } = service([{ id: 'u1', createdAt, updatedAt: createdAt }]);

    const res = await svc.execute('SELECT id, "createdAt", "updatedAt" FROM users', RO);

    expect(res.rows![0]).toMatchObject({
      createdAt: '2026-06-10T10:11:12.000Z',
      updatedAt: '2026-06-10T10:11:12.000Z',
    });
    expect(() => JSON.stringify(res)).not.toThrow();
  });

  it('rejects a write while read-only with 403', async () => {
    const { svc } = service();
    await expect(svc.execute('DELETE FROM users', RO)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects a data-modifying CTE disguised as a read', async () => {
    const { svc } = service();
    await expect(
      svc.execute('WITH x AS (DELETE FROM users RETURNING *) SELECT count(*) FROM x', RO)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects EXPLAIN ANALYZE which executes the underlying mutation', async () => {
    const { svc } = service();
    await expect(
      svc.execute('EXPLAIN ANALYZE DELETE FROM users WHERE false', RO)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('opens a READ ONLY transaction for read-only execution', async () => {
    const { svc, calls } = service([{ id: 1 }]);
    await svc.execute('SELECT 1', RO);
    expect(calls.execute).toBe('SET TRANSACTION READ ONLY');
  });

  it('throws 403 when the console is disabled', async () => {
    const { svc } = service([{ id: 1 }]);
    await expect(svc.execute('SELECT 1', { enabled: false, readonly: true })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  // Writes are allowed unless the project restricts them from Studio. Before,
  // a read-only env var pinned in every Console-provisioned stack left no way
  // to turn writes on from the product.
  it('resolves its own mode from CONSOLE_SQL_ENABLED and the database.sqlEditor setting', async () => {
    const previous = env.CONSOLE_SQL_ENABLED;
    const { svc, calls } = service([], 1);
    const settings: { allowWrites?: boolean } = {};
    (svc as any).di.SettingsService = { get: async (key: string) => (key === 'database.sqlEditor' ? settings : {}) };
    try {
      env.CONSOLE_SQL_ENABLED = true;
      await expect(svc.execute('DELETE FROM users WHERE id=1')).resolves.toMatchObject({ kind: 'write' });
      expect(calls.execute).toContain('DELETE');

      settings.allowWrites = false;
      await expect(svc.execute('DELETE FROM users WHERE id=1')).rejects.toMatchObject({ statusCode: 403 });
      await expect(svc.execute('SELECT 1')).resolves.toMatchObject({ kind: 'read' });

      // The setting never reaches past the operator's switch for the editor itself.
      env.CONSOLE_SQL_ENABLED = false;
      settings.allowWrites = true;
      await expect(svc.execute('SELECT 1')).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      env.CONSOLE_SQL_ENABLED = previous;
    }
  });

  it('flags a batch that wrote, even when its last statement reads', async () => {
    const { svc } = service([{ one: 1 }], 0);
    await expect(svc.execute('CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql; SELECT 1', RW)).resolves.toMatchObject({
      kind: 'read',
      wrote: true,
    });
    await expect(svc.execute('SELECT 1', RW)).resolves.not.toHaveProperty('wrote');
  });

  it('runs a write when read-only is disabled', async () => {
    const { svc, calls } = service([], 3);
    const res = await svc.execute('DELETE FROM users WHERE id=1', RW);
    expect(res.kind).toBe('write');
    expect(res.rowsAffected).toBe(3);
    expect(calls.execute).toContain('DELETE');
  });

  // A batch is one transaction: before, each statement autocommitted on its own
  // pooled connection, so `BEGIN; DELETE ...; ROLLBACK` deleted for real.
  describe('batch transaction', () => {
    function transactional() {
      const sent: string[] = [];
      const outcome: string[] = [];
      const { svc } = service([], 1);
      const prisma = (svc as any).di.prisma;
      prisma.$executeRawUnsafe = async (sql: string) => { sent.push(sql); return 1; };
      prisma.$transaction = async (fn: (tx: any) => any) => {
        try {
          const value = await fn(prisma);
          outcome.push('commit');
          return value;
        } catch (err) {
          outcome.push('rollback');
          throw err;
        }
      };
      return { svc, sent, outcome };
    }

    it('runs the batch in one transaction and keeps BEGIN/COMMIT out of it', async () => {
      const { svc, sent, outcome } = transactional();
      const res = await svc.execute('BEGIN; UPDATE users SET name = 1; -- done\nCOMMIT;', RW);
      expect(sent).toEqual(['UPDATE users SET name = 1']);
      expect(outcome).toEqual(['commit']);
      expect(res.warnings).toContain('BEGIN and COMMIT were skipped: the batch already ran as one transaction.');
    });

    it('rolls the whole batch back when it contains ROLLBACK, and returns what it saw', async () => {
      const { svc, sent, outcome } = transactional();
      const res = await svc.execute('BEGIN; DELETE FROM users WHERE id = 1; ROLLBACK;', RW);
      expect(sent).toEqual(['DELETE FROM users WHERE id = 1']);
      expect(outcome).toEqual(['rollback']);
      expect(res).toMatchObject({ kind: 'write', rowsAffected: 1 });
      expect(res.warnings).toContain('The batch contains ROLLBACK: it ran, then was rolled back. Nothing was committed.');
    });

    it('rolls back the statements before a failing one', async () => {
      const { svc, outcome } = transactional();
      const prisma = (svc as any).di.prisma;
      prisma.$executeRawUnsafe = async (sql: string) => {
        if (sql.startsWith('INSERT')) throw new Error('duplicate key');
        return 1;
      };
      await expect(svc.execute('UPDATE users SET name = 1; INSERT INTO users VALUES (1)', RW)).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(outcome).toEqual(['rollback']);
    });

    it('runs a statement Postgres refuses in a transaction on its own, and only alone', async () => {
      const { svc, sent, outcome } = transactional();
      await svc.execute('CREATE INDEX CONCURRENTLY i ON users (email)', RW);
      expect(sent).toEqual(['CREATE INDEX CONCURRENTLY i ON users (email)']);
      expect(outcome).toEqual([]);
      await expect(svc.execute('SELECT 1; VACUUM users', RW)).rejects.toMatchObject({ statusCode: 400 });
    });

    it('answers 400 for a batch made only of transaction control', async () => {
      const { svc } = transactional();
      await expect(svc.execute('BEGIN; ROLLBACK', RW)).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  it('audits every execution into the log buffer', async () => {
    const { svc, logBuffer } = service([{ id: 1 }]);
    await svc.execute('SELECT 1', RO);
    expect(logBuffer.pushed.length).toBe(1);
    expect(logBuffer.pushed[0].source).toBe('sql');
  });

  it('keeps password literals out of the audit line', async () => {
    const { svc, logBuffer } = service([], 0);
    await svc.execute("ALTER ROLE app PASSWORD 'hunter2'", RW);
    expect(logBuffer.pushed[0].message).not.toContain('hunter2');
    expect(logBuffer.pushed[0].message).toContain('[redacted]');
  });
});

describe('redactSqlSecrets', () => {
  it('masks quoted password literals, including escaped quotes', () => {
    expect(redactSqlSecrets("CREATE ROLE a LOGIN PASSWORD 'it''s' VALID UNTIL 'x'")).toBe(
      "CREATE ROLE a LOGIN PASSWORD '[redacted]' VALID UNTIL 'x'",
    );
  });
});
