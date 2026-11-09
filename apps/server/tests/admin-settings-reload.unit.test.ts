import { describe, it, expect, vi } from 'vitest';
import AdminSettingsController from '../controllers/admin/admin-settings.controller';

// The live auth instance derives Better Auth's trustedOrigins from the
// `server.cors` settings group (see AuthManager.build). Saving CORS must
// therefore rebuild it, otherwise browser clients on a newly-allowed origin
// keep getting 403 INVALID_ORIGIN until the container restarts.
function makeCtx() {
  const reload = vi.fn();
  const set = vi.fn().mockResolvedValue({ ok: true });
  const reset = vi.fn().mockResolvedValue({ source: 'env' });
  const di: any = {
    SettingsService: { set, reset, get: vi.fn().mockResolvedValue({}) },
    AuthManager: { reload },
  };
  return { di, reload, set, reset };
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('settingsPut auth reload', () => {
  it('reloads AuthManager when server.cors changes', async () => {
    const { di, reload } = makeCtx();
    const controller = new AdminSettingsController(di);
    const req: any = { params: { group: 'server.cors' }, body: { origins: 'https://app.example.com' }, user: { id: 'u1' } };

    await controller.settingsPut(req, makeRes(), vi.fn());

    expect(reload).toHaveBeenCalledOnce();
  });

  it('reloads AuthManager when an auth.* group changes', async () => {
    const { di, reload } = makeCtx();
    const controller = new AdminSettingsController(di);
    const req: any = { params: { group: 'auth.methods' }, body: {}, user: { id: 'u1' } };

    await controller.settingsPut(req, makeRes(), vi.fn());

    expect(reload).toHaveBeenCalledOnce();
  });

  it('reloads AuthManager when the shared SMS transport changes', async () => {
    const { di, reload } = makeCtx();
    const controller = new AdminSettingsController(di);
    const req: any = { params: { group: 'phone.sms' }, body: {}, user: { id: 'u1' } };

    await controller.settingsPut(req, makeRes(), vi.fn());

    expect(reload).toHaveBeenCalledOnce();
  });

  it('does not reload AuthManager for an unrelated group', async () => {
    const { di, reload } = makeCtx();
    const controller = new AdminSettingsController(di);
    const req: any = { params: { group: 'data.retention' }, body: {}, user: { id: 'u1' } };
    di.DataRetentionSchedulerService = { reschedule: vi.fn().mockResolvedValue(undefined) };

    await controller.settingsPut(req, makeRes(), vi.fn());

    expect(reload).not.toHaveBeenCalled();
  });

  it('resets the group and applies the same AuthManager reload on DELETE', async () => {
    const { di, reload, reset } = makeCtx();
    const controller = new AdminSettingsController(di);
    const req: any = { params: { group: 'auth.methods' }, user: { id: 'u1' } };

    await controller.settingsDelete(req, makeRes(), vi.fn());

    expect(reset).toHaveBeenCalledWith('auth.methods', 'u1');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('reschedules data retention after DELETE', async () => {
    const { di } = makeCtx();
    const reschedule = vi.fn().mockResolvedValue(undefined);
    di.DataRetentionSchedulerService = { reschedule };
    const controller = new AdminSettingsController(di);
    const req: any = { params: { group: 'data.retention' }, user: { id: 'u1' } };

    await controller.settingsDelete(req, makeRes(), vi.fn());

    expect(reschedule).toHaveBeenCalledOnce();
  });

  it.each(['settingsPut', 'settingsDelete'] as const)(
    'reschedules backups live after generic %s of backup.schedule',
    async method => {
      const { di } = makeCtx();
      const reschedule = vi.fn().mockResolvedValue(undefined);
      di.BackupSchedulerService = { reschedule };
      const controller = new AdminSettingsController(di);
      const req: any = {
        params: { group: 'backup.schedule' },
        body: { enabled: true, cron: '0 4 * * *', retention: 5, offsite: false },
        user: { id: 'u1' },
      };

      await controller[method](req, makeRes(), vi.fn());

      expect(reschedule).toHaveBeenCalledOnce();
    },
  );
});
