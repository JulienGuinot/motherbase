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

  it('never sends transaction control to the shared pool, and says it skipped it', async () => {
    const sent: string[] = [];
    const { svc } = service([], 1);
    (svc as any).di.prisma.$executeRawUnsafe = async (sql: string) => { sent.push(sql); return 1; };

    const res = await svc.execute('BEGIN; UPDATE users SET name = 1; -- done\nCOMMIT;', RW);

    expect(sent).toEqual(['UPDATE users SET name = 1']);
    expect(res.warnings).toContain('BEGIN, COMMIT and ROLLBACK were skipped: the editor runs each statement on its own.');
    await expect(svc.execute('BEGIN; ROLLBACK', RW)).rejects.toMatchObject({ statusCode: 400 });
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
