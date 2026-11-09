import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { BackupService } from '../services/admin/backup.service';
import { BackupSchedulerService } from '../services/admin/backup-scheduler.service';
import { SettingsService } from '../services/settings.service';

// ── helpers ──────────────────────────────────────────────────────────────────

/** AppSetting-backed SettingsService with an in-memory prisma double. */
function settingsService() {
  const store: Record<string, any> = {};
  const prisma = {
    user: { findUnique: async ({ where }: any) => (where.id === 'u1' ? { id: 'u1' } : null) },
    appSetting: {
      findUnique: async ({ where }: any) => store[where.key] ?? null,
      upsert: async ({ where, create, update }: any) => {
        store[where.key] = { key: where.key, ...(store[where.key] || create), ...update };
        return store[where.key];
      },
    },
  };
  return new SettingsService({ prisma } as any);
}

// ── BackupService ────────────────────────────────────────────────────────────

describe('BackupService remote-op gating', () => {
  const offsiteOffDi = { SettingsService: { get: async () => ({ offsite: false }) } } as any;

  it('skips upload when offsite off (no throw, no S3 call)', async () => {
    const svc = new BackupService(offsiteOffDi);
    const upload = vi.fn();
    (svc as any).remote = { upload };
    const r = await svc.uploadBackup('/tmp/x.sql', 'x.sql');
    expect(r.skipped).toBe(true);
    expect(upload).not.toHaveBeenCalled();
  });

  it('listRemote returns [] and pruneRemote skips when offsite is off', async () => {
    const svc = new BackupService(offsiteOffDi);
    (svc as any).remote = { list: vi.fn(), prune: vi.fn() };
    expect(await svc.listRemote()).toEqual([]);
    expect(await svc.pruneRemote(3)).toEqual([]);
  });

  it('pruneLocal keeps exactly N newest and unlinks the rest', async () => {
    const svc = new BackupService({} as any);
    vi.spyOn(svc as any, 'list').mockResolvedValue(
      ['n1', 'n2', 'n3', 'n4', 'n5'].map(name => ({ name, path: name, size: 1, createdAt: name, kind: 'database' }))
    );
    const unlink = vi.spyOn(fs, 'unlink').mockResolvedValue(undefined as any);
    const deleted = await svc.pruneLocal(2);
    expect(deleted).toEqual(['n3', 'n4', 'n5']);
    expect(unlink).toHaveBeenCalledTimes(3);
    unlink.mockRestore();
  });

  it('pruneLocal never touches a full archive or a project export', async () => {
    // The retention window belongs to the scheduled .sql job. This used to walk
    // every file in the directory, so a daily dump with retention 2 deleted the
    // operator's full-project .tar a couple of days after it was taken.
    const svc = new BackupService({} as any);
    vi.spyOn(svc as any, 'list').mockResolvedValue([
      { name: 'db-3.sql', path: 'db-3.sql', size: 1, createdAt: '3', kind: 'database' },
      { name: 'full.tar', path: 'full.tar', size: 1, createdAt: '2', kind: 'full' },
      { name: 'db-2.sql', path: 'db-2.sql', size: 1, createdAt: '2', kind: 'database' },
      { name: 'project.json', path: 'project.json', size: 1, createdAt: '1', kind: 'export' },
      { name: 'db-1.sql', path: 'db-1.sql', size: 1, createdAt: '1', kind: 'database' },
    ]);
    const unlink = vi.spyOn(fs, 'unlink').mockResolvedValue(undefined as any);
    const deleted = await svc.pruneLocal(2);
    expect(deleted).toEqual(['db-1.sql']);
    expect(unlink).toHaveBeenCalledTimes(1);
    unlink.mockRestore();
  });

  it('importBackup stores the upload under a generated name, not the uploaded one', async () => {
    // The uploaded name is attacker-controlled and the directory it lands in is
    // the one every restore reads from: reusing it would let an upload
    // overwrite an existing dump, or walk out of BACKUP_DIR entirely.
    const svc = new BackupService({} as any);
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as any);
    const copy = vi.spyOn(fs, 'copyFile').mockResolvedValue(undefined as any);
    vi.spyOn(fs, 'stat').mockResolvedValue({ size: 10, birthtime: new Date(0) } as any);

    const saved = await svc.importBackup({ tempPath: '/tmp/abc', originalName: '../../etc/evil.sql' });

    expect(saved.name).toMatch(/^motherbase-uploaded-.*\.sql$/);
    expect(saved.name).not.toContain('evil');
    expect(saved.restorable).toBe(true); // .sql, so the existing restore path can read it
    expect(String(copy.mock.calls[0][1])).toContain('motherbase-uploaded-');
    vi.restoreAllMocks();
  });

  it('importBackup refuses a file kind no restore path can read', async () => {
    const svc = new BackupService({} as any);
    await expect(svc.importBackup({ tempPath: '/tmp/abc', originalName: 'notes.txt' })).rejects.toThrow(
      /\.sql dumps, \.tar project archives and \.json exports/
    );
  });

  it('restoreFromRemote requires confirm, then downloads before restoring', async () => {
    const svc = new BackupService({} as any);
    const order: string[] = [];
    (svc as any).downloadBackup = vi.fn(async () => {
      order.push('download');
      return { name: 'remote.sql', path: 'remote.sql', size: 1, createdAt: '' };
    });
    vi.spyOn(svc, 'restoreDatabase').mockImplementation(async () => {
      order.push('restore');
      return { stdout: '', stderr: '' };
    });

    await svc.restoreFromRemote({ key: 'remote.sql', confirm: 'RESTORE' });
    expect(order).toEqual(['download', 'restore']);

    await expect(svc.restoreFromRemote({ key: 'remote.sql' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.restoreFromRemote({ key: 'remote.sql', confirm: 'nope' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

// ── BackupSchedulerService ───────────────────────────────────────────────────

function schedulerHarness(config: any) {
  const order: string[] = [];
  const backupService = {
    config: vi.fn(async () => config),
    backupDatabase: vi.fn(async () => {
      order.push('backup');
      return { file: { name: 'f.sql', path: '/backups/f.sql', size: 1, createdAt: '' }, stdout: '', stderr: '' };
    }),
    uploadBackup: vi.fn(async () => {
      order.push('upload');
      return { skipped: false, key: 'f.sql' };
    }),
    pruneLocal: vi.fn(async () => {
      order.push('pruneLocal');
      return [];
    }),
    pruneRemote: vi.fn(async () => {
      order.push('pruneRemote');
      return [];
    }),
  };
  const sched = new BackupSchedulerService({ BackupService: backupService, JobLedgerService: { record: <F>(_job: string, fn: () => Promise<F>) => fn(), note: async () => {} } } as any);
  let captured: (() => void) | null = null;
  const stop = vi.fn();
  (sched as any).scheduler = {
    schedule: (_expr: string, fn: () => void) => {
      captured = fn;
      return { stop };
    },
  };
  return { sched, backupService, order, fire: () => captured?.(), stop };
}

describe('BackupSchedulerService', () => {
  it('does not schedule when disabled', async () => {
    const { sched } = schedulerHarness({ enabled: false, cron: '* * * * *', retention: 3, offsite: false });
    await sched.start();
    expect(sched.isScheduled()).toBe(false);
  });

  it('schedules when enabled and runs the full offsite cycle in order', async () => {
    const { sched, order } = schedulerHarness({ enabled: true, cron: '* * * * *', retention: 3, offsite: true });
    await sched.start();
    expect(sched.isScheduled()).toBe(true);
    const summary = await sched.runOnce();
    expect(order).toEqual(['backup', 'upload', 'pruneLocal', 'pruneRemote']);
    expect(summary).toMatchObject({ ran: true, offsite: true, uploaded: true });
  });

  it('skips remote steps (no throw) when offsite is off', async () => {
    const { sched, backupService, order } = schedulerHarness({
      enabled: true,
      cron: '* * * * *',
      retention: 3,
      offsite: false,
    });
    await sched.runOnce();
    expect(order).toEqual(['backup', 'pruneLocal']);
    expect(backupService.uploadBackup).not.toHaveBeenCalled();
    expect(backupService.pruneRemote).not.toHaveBeenCalled();
  });

  it('fires a backup on the scheduled tick', async () => {
    const { sched, backupService, fire } = schedulerHarness({
      enabled: true,
      cron: '* * * * *',
      retention: 3,
      offsite: false,
    });
    await sched.start();
    fire();
    await new Promise(r => setImmediate(r));
    expect(backupService.backupDatabase).toHaveBeenCalledTimes(1);
  });

  it('skips overlapping runs', async () => {
    const { sched, backupService } = schedulerHarness({
      enabled: true,
      cron: '* * * * *',
      retention: 3,
      offsite: false,
    });
    let release!: () => void;
    backupService.backupDatabase.mockImplementation(
      () =>
        new Promise(res => {
          release = () => res({ file: { name: 'f.sql', path: '/f.sql', size: 1, createdAt: '' }, stdout: '', stderr: '' });
        })
    );
    const p1 = sched.runOnce();
    const second = await sched.runOnce(); // in-progress → skipped
    expect(second.ran).toBe(false);
    release();
    await p1;
    expect(backupService.backupDatabase).toHaveBeenCalledTimes(1);
  });
});

// ── Config round-trip (AppSetting) + live reschedule ─────────────────────────

describe('backup config via AppSetting + reschedule', () => {
  beforeEach(() => {
    delete process.env.BACKUP_ENABLED;
  });

  it('round-trips config through AppSetting (overrides env)', async () => {
    const settings = settingsService();
    // env fallback first
    await expect(settings.get('backup.schedule')).resolves.toMatchObject({ enabled: false, cron: '0 3 * * *' });
    await settings.set('backup.schedule', { enabled: true, cron: '0 5 * * *', retention: 10, offsite: true }, 'u1');
    await expect(settings.get('backup.schedule')).resolves.toMatchObject({
      enabled: true,
      cron: '0 5 * * *',
      retention: 10,
      offsite: true,
    });
    expect(await settings.source('backup.schedule')).toBe('db');
  });

  it('reschedules live when config flips enabled', async () => {
    const settings = settingsService();
    const backupService = { config: () => settings.get('backup.schedule') };
    const sched = new BackupSchedulerService({ BackupService: backupService, JobLedgerService: { record: <F>(_job: string, fn: () => Promise<F>) => fn(), note: async () => {} } } as any);
    const stop = vi.fn();
    (sched as any).scheduler = { schedule: (_e: string, _fn: () => void) => ({ stop }) };

    await settings.set('backup.schedule', { enabled: false, cron: '* * * * *', retention: 3, offsite: false }, 'u1');
    await sched.reschedule();
    expect(sched.isScheduled()).toBe(false);

    await settings.set('backup.schedule', { enabled: true, cron: '* * * * *', retention: 3, offsite: false }, 'u1');
    await sched.reschedule();
    expect(sched.isScheduled()).toBe(true);
  });
});

describe('BackupService restore portability', () => {
  // The runtime image ships pg_dump 17 against a Postgres 16 project, so every
  // dump this project takes of itself carries `SET transaction_timeout` on line
  // 13. psql runs with ON_ERROR_STOP, so that one line used to abort the whole
  // restore, and the CI restore drill failed on it.
  it('comments out preamble settings the target cannot know before running psql', async () => {
    const dump = path.join(os.tmpdir(), `mb-restore-${Date.now()}.sql`);
    await fs.writeFile(
      dump,
      [
        'SET statement_timeout = 0;',
        'SET transaction_timeout = 0;',
        'SET row_security = off;',
        '',
        'CREATE TABLE public.probe (id text);',
      ].join('\n'),
      'utf8'
    );

    const svc = new BackupService({} as any);
    vi.spyOn(svc as any, 'resolveInsideRoot').mockReturnValue(dump);
    vi.spyOn(svc as any, 'assertReadable').mockResolvedValue(undefined);
    const run = vi.spyOn(svc as any, 'run').mockResolvedValue({ stdout: '', stderr: '' });

    await svc.restoreDatabase({ file: 'x.sql', confirm: 'RESTORE' });

    const rewritten = await fs.readFile(dump, 'utf8');
    expect(rewritten).toMatch(/^-- SET transaction_timeout = 0;/m);
    expect(rewritten).toMatch(/^SET statement_timeout = 0;$/m);
    expect(rewritten).toMatch(/^CREATE TABLE public\.probe \(id text\);$/m);
    expect(run).toHaveBeenCalledOnce();

    await fs.unlink(dump);
  });
});
