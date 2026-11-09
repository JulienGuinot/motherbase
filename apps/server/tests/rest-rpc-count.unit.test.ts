import { describe, it, expect, vi } from 'vitest';
import RestApiController from '../controllers/rest-api.controller';

// `rpc(fn, args, { count: 'exact' })` reads its total from Content-Range, the
// way a table read does. The /rpc/ route used to send none, so the count was
// always null even though every row of the result was right there.

function call(result: { rows: unknown[]; single: boolean; scalar: boolean }, prefer?: string) {
  const di = { RestApiService: { handleRpc: vi.fn(async () => result) } } as any;
  const controller = new RestApiController(di);
  const headers: Record<string, string> = {};
  const res: any = {
    statusCode: 200,
    setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value; },
    status(code: number) { this.statusCode = code; return this; },
    json: vi.fn(function (this: any) { return this; }),
    end: vi.fn(function (this: any) { return this; }),
    type: vi.fn(), send: vi.fn(),
  };
  const req: any = { params: { fn: 'list_things' }, body: {}, headers: prefer ? { prefer } : {}, query: {} };
  return { run: () => controller.rpcPost(req, res, vi.fn()), headers, res };
}

describe('/rest/v1/rpc Content-Range', () => {
  it('carries the exact total of a set-returning call when count=exact is asked', async () => {
    const { run, headers } = call({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }], single: false, scalar: false }, 'count=exact');
    await run();
    expect(headers['content-range']).toBe('0-2/3');
  });

  it('says the total is unknown when no count was asked, as a table read does', async () => {
    const { run, headers } = call({ rows: [{ id: 1 }], single: false, scalar: false });
    await run();
    expect(headers['content-range']).toBe('0-0/*');
  });

  it('reports an empty result as a zero total', async () => {
    const { run, headers } = call({ rows: [], single: false, scalar: false }, 'count=exact');
    await run();
    expect(headers['content-range']).toBe('*/0');
  });

  it('sends no range for a scalar or single-row function, which is not a collection', async () => {
    const { run, headers } = call({ rows: [42], single: true, scalar: true }, 'count=exact');
    await run();
    expect(headers['content-range']).toBeUndefined();
  });
});
