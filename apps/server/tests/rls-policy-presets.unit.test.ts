import { describe, expect, it, vi } from 'vitest';
import AdminSchemaController from '../controllers/admin/admin-schema.controller';
import { RLS_POLICY_PRESETS, RlsService, parseRlsPolicyPreset, policiesForPreset } from '../services/admin/rls.service';

describe('RLS policy presets', () => {
  it('accepts every supported preset and rejects missing or unknown values', () => {
    for (const preset of RLS_POLICY_PRESETS) expect(parseRlsPolicyPreset(preset)).toBe(preset);
    expect(() => parseRlsPolicyPreset(undefined)).toThrow(/policyPreset must be one of/);
    expect(() => parseRlsPolicyPreset('permissive')).toThrow(/policyPreset must be one of/);
  });

  it('maps presets to explicit least-privilege policies', () => {
    expect(policiesForPreset('todo', 'starter')).toEqual([
      { table: 'todo', name: 'starter_public_read', command: 'SELECT', role: 'anon', using: 'true' },
      {
        table: 'todo',
        name: 'starter_authenticated_crud',
        command: 'ALL',
        role: 'authenticated',
        using: 'true',
        check: 'true',
      },
    ]);
    expect(policiesForPreset('todo', 'public_crud')).toHaveLength(2);
    expect(policiesForPreset('todo', 'authenticated_crud')).toHaveLength(1);
    expect(policiesForPreset('todo', 'admin_only')[0]).toMatchObject({
      role: 'authenticated',
      using: "(select auth.jwt()) ->> 'user_role' = 'ADMIN'",
      check: "(select auth.jwt()) ->> 'user_role' = 'ADMIN'",
    });
    expect(policiesForPreset('todo', 'blocked')).toEqual([]);
  });

  it('always enables RLS and resets grants, including for the blocked preset', async () => {
    const sql: string[] = [];
    const executor = {
      $executeRawUnsafe: vi.fn(async (statement: string) => {
        sql.push(statement);
        return 0;
      }),
      $queryRawUnsafe: vi.fn(async () => [{ name: 'todo_id_seq' }]),
    };
    const service = new RlsService({} as any);

    await service.applyPreset('todo', 'blocked', executor as any);
    expect(sql).toEqual([
      'ALTER TABLE "todo" ENABLE ROW LEVEL SECURITY',
      'REVOKE ALL PRIVILEGES ON TABLE "todo" FROM anon, authenticated',
      'REVOKE ALL PRIVILEGES ON SEQUENCE "todo_id_seq" FROM anon, authenticated',
    ]);

    sql.length = 0;
    await service.applyPreset('todo', 'starter', executor as any);
    expect(sql[0]).toBe('ALTER TABLE "todo" ENABLE ROW LEVEL SECURITY');
    expect(sql.slice(1)).toEqual([
      'REVOKE ALL PRIVILEGES ON TABLE "todo" FROM anon, authenticated',
      'REVOKE ALL PRIVILEGES ON SEQUENCE "todo_id_seq" FROM anon, authenticated',
      'GRANT SELECT ON TABLE "todo" TO anon',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "todo" TO authenticated',
      'GRANT USAGE ON SEQUENCE "todo_id_seq" TO authenticated',
      'CREATE POLICY "starter_public_read" ON "todo" FOR SELECT TO anon USING (true)',
      'CREATE POLICY "starter_authenticated_crud" ON "todo" FOR ALL TO authenticated USING (true) WITH CHECK (true)',
    ]);
  });

  it.each([
    ['blocked', []],
    [
      'starter',
      [
        'GRANT SELECT ON TABLE "todo" TO anon',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "todo" TO authenticated',
        'GRANT USAGE ON SEQUENCE "todo_id_seq" TO authenticated',
      ],
    ],
    [
      'public_crud',
      [
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "todo" TO anon',
        'GRANT USAGE ON SEQUENCE "todo_id_seq" TO anon',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "todo" TO authenticated',
        'GRANT USAGE ON SEQUENCE "todo_id_seq" TO authenticated',
      ],
    ],
    [
      'authenticated_crud',
      [
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "todo" TO authenticated',
        'GRANT USAGE ON SEQUENCE "todo_id_seq" TO authenticated',
      ],
    ],
    [
      'admin_only',
      [
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "todo" TO authenticated',
        'GRANT USAGE ON SEQUENCE "todo_id_seq" TO authenticated',
      ],
    ],
    [
      'owner_only',
      [
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "todo" TO authenticated',
        'GRANT USAGE ON SEQUENCE "todo_id_seq" TO authenticated',
      ],
    ],
    [
      'org_scoped',
      [
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "todo" TO authenticated',
        'GRANT USAGE ON SEQUENCE "todo_id_seq" TO authenticated',
      ],
    ],
    [
      'public_read_owner_write',
      [
        'GRANT SELECT ON TABLE "todo" TO anon',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "todo" TO authenticated',
        'GRANT USAGE ON SEQUENCE "todo_id_seq" TO authenticated',
      ],
    ],
  ] as const)('grants only the privileges required by %s', async (preset, expectedGrants) => {
    const sql: string[] = [];
    const executor = {
      $executeRawUnsafe: vi.fn(async (statement: string) => {
        sql.push(statement);
        return 0;
      }),
      $queryRawUnsafe: vi.fn(async () => [{ name: 'todo_id_seq' }]),
    };

    await new RlsService({} as any).applyPreset('todo', preset, executor as any);

    expect(sql.filter(statement => statement.startsWith('GRANT'))).toEqual(expectedGrants);
    expect(sql.join('\n')).not.toMatch(/TRUNCATE|REFERENCES|TRIGGER/);
  });

  it('grants the matching SQL privileges for a manually created policy', async () => {
    const sql: string[] = [];
    const executor = {
      $executeRawUnsafe: vi.fn(async (statement: string) => {
        sql.push(statement);
        return 0;
      }),
      $queryRawUnsafe: vi.fn(async () => [{ name: 'todo_id_seq' }]),
    };

    await new RlsService({} as any).createPolicy(
      { table: 'todo', name: 'writer', command: 'ALL', role: 'authenticated', using: 'true', check: 'true' },
      executor as any
    );

    expect(sql).toEqual([
      'CREATE POLICY "writer" ON "todo" FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "todo" TO authenticated',
      'GRANT USAGE ON SEQUENCE "todo_id_seq" TO authenticated',
    ]);
    expect(sql.join('\n')).not.toMatch(/TRUNCATE|REFERENCES|TRIGGER/);
  });

  it('does not revoke grants when a policy is dropped because enabled RLS remains authoritative', async () => {
    const $executeRawUnsafe = vi.fn(async () => 0);
    const service = new RlsService({ prisma: { $executeRawUnsafe } } as any);

    await service.dropPolicy('todo', 'reader');

    expect($executeRawUnsafe).toHaveBeenCalledOnce();
    expect($executeRawUnsafe).toHaveBeenCalledWith('DROP POLICY IF EXISTS "reader" ON "todo"');
  });
});

describe('AdminSchemaController.createTable', () => {
  function response() {
    const res: any = {};
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    return res;
  }

  it('creates the table and applies its preset inside the same transaction', async () => {
    const transaction = { $executeRawUnsafe: vi.fn() };
    const executeRaw = vi.fn(async () => undefined);
    const applyPreset = vi.fn(async () => undefined);
    const di: any = {
      prisma: { $transaction: vi.fn(async (work: (tx: any) => Promise<void>) => work(transaction)) },
      SchemaService: { executeRaw },
      RlsService: { applyPreset },
    };
    const controller = new AdminSchemaController(di);
    const next = vi.fn();
    const res = response();
    const sql = 'CREATE TABLE "todo" ("id" uuid PRIMARY KEY);';

    await controller.createTable({ body: { sql, policyPreset: 'starter' } } as any, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(executeRaw).toHaveBeenCalledWith(sql, transaction);
    expect(applyPreset).toHaveBeenCalledWith('todo', 'starter', transaction);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects an invalid preset before starting a transaction', async () => {
    const transaction = vi.fn();
    const di: any = {
      prisma: { $transaction: transaction },
      SchemaService: { executeRaw: vi.fn() },
      RlsService: { applyPreset: vi.fn() },
    };
    const controller = new AdminSchemaController(di);
    const next = vi.fn();

    await controller.createTable(
      { body: { sql: 'CREATE TABLE "todo" ("id" uuid);', policyPreset: 'unknown' } } as any,
      response(),
      next
    );

    expect(transaction).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('parameterises the owner and tenant columns instead of hard-coding a name', () => {
    expect(policiesForPreset('todo', 'owner_only')[0]).toMatchObject({
      command: 'ALL',
      role: 'authenticated',
      using: '"owner_id" = auth.uid()',
      check: '"owner_id" = auth.uid()',
    });
    expect(policiesForPreset('todo', 'owner_only', { ownerColumn: 'created_by' })[0].using)
      .toBe('"created_by" = auth.uid()');

    expect(policiesForPreset('todo', 'org_scoped', { orgColumn: 'tenant', orgClaim: 'tenant_id' })[0].using)
      .toBe(`"tenant" = ((select auth.jwt()) ->> 'tenant_id')`);
  });

  it('refuses a column or claim name that is not a plain identifier', () => {
    expect(() => policiesForPreset('todo', 'owner_only', { ownerColumn: 'owner"; DROP TABLE x --' }))
      .toThrow(/Invalid SQL identifier/);
    expect(() => policiesForPreset('todo', 'org_scoped', { orgClaim: "a' OR '1'='1" }))
      .toThrow(/Invalid JWT claim name/);
  });

  it('writes soft_delete as per-command policies, never one FOR ALL', () => {
    // A FOR ALL policy applies its USING to new rows too, which makes the soft
    // delete fail against its own predicate. See the comment in rls.service.ts.
    const policies = policiesForPreset('todo', 'soft_delete');
    expect(policies.map(p => p.command)).toEqual(['SELECT', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']);
    expect(policies.every(p => p.command !== 'ALL')).toBe(true);
  });
});
