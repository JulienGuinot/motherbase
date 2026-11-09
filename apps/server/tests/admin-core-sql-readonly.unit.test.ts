import { describe, it, expect, vi } from 'vitest';
import AdminCoreController from '../controllers/admin/admin-core.controller';

// There is no existing precedent in apps/server/tests for instantiating a
// controller directly (tests here target services, not Express routing), so
// this exercises the handler function the same way the other unit tests
// exercise a service: instantiate the class with a stubbed di container and
// call the method with fake req/res/next, no HTTP server involved.

function fakeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

describe('AdminCoreController.sqlReadonly', () => {
  it('always calls SqlService.execute with a hardcoded readonly: true, regardless of the request body', async () => {
    const execute = vi.fn(async () => ({ kind: 'read', columns: ['id'], rows: [{ id: 1 }] }));
    const di: any = { SqlService: { execute } };
    const controller = new AdminCoreController(di);
    const req: any = { body: { sql: 'select 1', readonly: false, enabled: false } };
    const res = fakeRes();
    const next = vi.fn();

    await controller.sqlReadonly(req, res, next);

    expect(execute).toHaveBeenCalledWith('select 1', { enabled: true, readonly: true });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('forwards a rejected write to next() instead of throwing, and never reaches the response', async () => {
    const error = Object.assign(new Error('Only read statements are allowed'), { statusCode: 403 });
    const execute = vi.fn(async () => {
      throw error;
    });
    const di: any = { SqlService: { execute } };
    const controller = new AdminCoreController(di);
    const req: any = { body: { sql: 'delete from users' } };
    const res = fakeRes();
    const next = vi.fn();

    await controller.sqlReadonly(req, res, next);

    expect(execute).toHaveBeenCalledWith('delete from users', { enabled: true, readonly: true });
    expect(next).toHaveBeenCalledWith(error);
    expect(res.json).not.toHaveBeenCalled();
  });

  it('leaves the /sql handler on the service-configured mode', async () => {
    const execute = vi.fn(async () => ({ kind: 'write', rowsAffected: 1 }));
    const di: any = { SqlService: { execute } };
    const controller = new AdminCoreController(di);
    const req: any = { body: { sql: 'delete from users where id = 1' } };
    const res = fakeRes();
    const next = vi.fn();

    await controller.sql(req, res, next);

    expect(execute).toHaveBeenCalledWith('delete from users where id = 1');
  });
});
