import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import prisma from '../lib/prisma';
import { JobLedgerService } from '../services/admin/job-ledger.service';

/**
 * The ledger against a live Postgres, and the migration that creates it.
 *
 * The table is created here by executing the migration file itself rather than a
 * copy of its DDL: a fixture that drifts from the migration would test a table
 * production does not have.
 */

/**
 * Every migration that touches this table, in order.
 *
 * Discovered rather than listed: pinning one filename meant the column a later
 * migration added existed in production and not here, and the test that should
 * have caught it was the one testing the wrong table.
 */
const MIGRATIONS = (() => {
  const root = path.resolve(__dirname, '../prisma/migrations');
  return fs
    .readdirSync(root)
    .filter(name => /job_runs/.test(name))
    .sort()
    .map(name => path.join(root, name, 'migration.sql'));
})();

const svc = new JobLedgerService({ prisma, EventDispatcherService: { dispatch: async () => {} } } as any);

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS platform`);
  expect(MIGRATIONS.length).toBeGreaterThan(1);
  for (const migration of MIGRATIONS) {
    for (const statement of fs.readFileSync(migration, 'utf8').split(';')) {
      const sql = statement.trim();
      if (sql) await prisma.$executeRawUnsafe(sql);
    }
  }
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS platform.job_runs`);
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE platform.job_runs`);
});

describe('job ledger', () => {
  it('records a successful run', async () => {
    const value = await svc.record('backup', async () => 'done');
    expect(value).toBe('done');

    const runs = await svc.list({ job: 'backup' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ job: 'backup', status: 'ok', error: null });
    expect(runs[0].finishedAt).not.toBeNull();
  });

  it('records the failure and rethrows, so the caller still sees the error', async () => {
    await expect(svc.record('backup', async () => {
      throw new Error('pg_dump: connection refused');
    })).rejects.toThrow('connection refused');

    const [row] = await svc.list({ job: 'backup' });
    expect(row.status).toBe('failed');
    expect(row.error).toContain('connection refused');
  });

  it('leaves a running row behind while the work is in flight', async () => {
    // A process killed mid-run must leave `running`, not nothing: "no row" is
    // indistinguishable from "never scheduled", which is the case the missed
    // window rule exists to catch.
    let seen: string | undefined;
    await svc.record('slow', async () => {
      seen = (await svc.list({ job: 'slow' }))[0]?.status;
    });
    expect(seen).toBe('running');
  });

  it('degrades to no ledger rather than failing the job when the table is missing', async () => {
    await prisma.$executeRawUnsafe(`ALTER TABLE platform.job_runs RENAME TO job_runs_hidden`);
    try {
      await expect(svc.record('backup', async () => 'still ran')).resolves.toBe('still ran');
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE platform.job_runs_hidden RENAME TO job_runs`);
    }
  });

  it('prunes rows older than the retention window and keeps the rest', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.job_runs (job, status, started_at) VALUES
         ('backup','ok', now() - interval '40 days'),
         ('backup','ok', now() - interval '1 day')`
    );
    const deleted = await svc.prune(30);
    expect(deleted).toBe(1);
    expect(await svc.list({ job: 'backup' })).toHaveLength(1);
  });

  it('derives alerts from what was really recorded', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(svc.record('backup', async () => {
        throw new Error('disk full');
      })).rejects.toThrow();
    }
    const alerts = await svc.alerts();
    expect(alerts.map(a => a.kind)).toContain('consecutive_failures');
    expect(alerts.find(a => a.kind === 'consecutive_failures')!.detail.failures).toBe(3);
  });

  it('keeps the ledger out of reach of the data-plane roles', async () => {
    const grants = await prisma.$queryRawUnsafe<any[]>(
      `SELECT grantee FROM information_schema.role_table_grants
        WHERE table_schema = 'platform' AND table_name = 'job_runs'
          AND grantee IN ('anon','authenticated')`
    );
    expect(grants).toEqual([]);
  });
});

/**
 * The run's own report of what it did.
 *
 * Without it the drawer had nothing to show for a run that succeeded: a storage
 * cleanup that removed 40,000 objects and one that removed none were the same
 * green row.
 */
describe('job ledger output and trigger', () => {
  it('keeps what a successful run returned', async () => {
    await svc.record('storage-cleanup', async () => ({ ran: true, cleaned: 7 }));

    const [run] = await svc.list({ job: 'storage-cleanup' });
    expect(run.status).toBe('ok');
    expect(run.output).toContain('"cleaned": 7');
    expect(run.trigger).toBe('schedule');
  });

  it('marks a forced run manual, so it is never read as the timer firing', async () => {
    await svc.record('backup', async () => 'dumped', 'manual');
    await svc.note('realtime-outbox', 'ok', null, { output: { claimed: 3 }, trigger: 'manual' });

    const [backup] = await svc.list({ job: 'backup' });
    const [outbox] = await svc.list({ job: 'realtime-outbox' });
    expect(backup.trigger).toBe('manual');
    expect(outbox.trigger).toBe('manual');
    expect(outbox.output).toContain('"claimed": 3');
  });

  it('defaults a plain note to a scheduled run', async () => {
    await svc.note('bucket-deletion', 'ok');
    const [run] = await svc.list({ job: 'bucket-deletion' });
    expect(run.trigger).toBe('schedule');
    expect(run.output).toBeNull();
  });

  it('records no output for a failed run, and the error instead', async () => {
    await expect(
      svc.record('backup', async () => {
        throw new Error('pg_dump: connection refused');
      })
    ).rejects.toThrow();

    const [run] = await svc.list({ job: 'backup' });
    expect(run.status).toBe('failed');
    expect(run.error).toContain('connection refused');
    expect(run.output).toBeNull();
  });
});
