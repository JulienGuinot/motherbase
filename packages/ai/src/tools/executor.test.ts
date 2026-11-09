import { describe, expect, it, vi } from 'vitest';
import { buildUrl, createHttpExecutor } from './executor';
import { toolByName } from './registry';

describe('buildUrl', () => {
  it('interpolates path params and puts the rest in the query string', () => {
    const spec = toolByName('list_indexes')!;
    expect(buildUrl('http://api/admin', spec, { table: 'users', schema: 'auth' })).toBe(
      'http://api/admin/schema/tables/users/indexes?schema=auth',
    );
  });

  it('leaves a POST body out of the query string', () => {
    const spec = toolByName('run_select')!;
    expect(buildUrl('http://api/admin', spec, { sql: 'select 1' })).toBe('http://api/admin/sql/readonly');
  });

  it('encodes path params', () => {
    const spec = toolByName('list_indexes')!;
    expect(buildUrl('http://api/admin', spec, { table: 'we ird' })).toBe(
      'http://api/admin/schema/tables/we%20ird/indexes',
    );
  });
});

describe('createHttpExecutor', () => {
  it('forwards the caller credential and unwraps the api-response envelope', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ name: 'users' }] }),
    })) as never;
    const exec = createHttpExecutor({ baseUrl: 'http://api/admin', authHeaders: { Authorization: 'Bearer tok' }, fetchImpl });

    const out = await exec({ id: 'c1', name: 'list_tables', input: {} });

    expect(out).toEqual({ result: [{ name: 'users' }], isError: false });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('returns an error result for a failed request instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ message: 'Forbidden' }),
    })) as never;
    const exec = createHttpExecutor({ baseUrl: 'http://api/admin', authHeaders: { Authorization: 'Bearer tok' }, fetchImpl });

    expect(await exec({ id: 'c1', name: 'list_tables', input: {} })).toEqual({
      result: { error: 'Forbidden', status: 403 },
      isError: true,
    });
  });

  it('refuses a write dressed up as run_select, without calling the API', async () => {
    const fetchImpl = vi.fn() as never;
    const exec = createHttpExecutor({ baseUrl: 'http://api/admin', authHeaders: { Authorization: 'Bearer tok' }, fetchImpl });

    const out = await exec({ id: 'c1', name: 'run_select', input: { sql: 'delete from users' } });

    expect(out.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an unknown tool name', async () => {
    const exec = createHttpExecutor({ baseUrl: 'http://api/admin', authHeaders: { Authorization: 'Bearer tok' } });
    expect(await exec({ id: 'c1', name: 'drop_everything', input: {} })).toEqual({
      result: { error: 'Unknown tool: drop_everything' },
      isError: true,
    });
  });

  it('applies the tool summarizer to a large result', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ i }));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { rows } }),
    })) as never;
    const exec = createHttpExecutor({ baseUrl: 'http://api/admin', authHeaders: { Authorization: 'Bearer tok' }, fetchImpl });

    const out = await exec({ id: 'c1', name: 'run_select', input: { sql: 'select 1' } });
    expect((out.result as { rows: unknown[] }).rows).toHaveLength(50);
    expect((out.result as { truncated: boolean }).truncated).toBe(true);
  });

  it('survives a JSON null body', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => null })) as never;
    const exec = createHttpExecutor({ baseUrl: 'http://api/admin', authHeaders: { Authorization: 'Bearer tok' }, fetchImpl });

    const out = await exec({ id: 'c1', name: 'run_select', input: { sql: 'select 1' } });
    expect(out).toEqual({ result: null, isError: false });
  });
});

describe('executor cancellation', () => {
  it('does not send a request for an already aborted run', async () => {
    const controller = new AbortController(); controller.abort();
    const fetchImpl = vi.fn();
    const execute = createHttpExecutor({ baseUrl: 'http://api/admin', authHeaders: {}, fetchImpl });
    expect((await execute({ id: '1', name: 'list_tables', input: {} }, controller.signal)).isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('aborts an in-flight fetch when the run is cancelled', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      started();
    }));
    const execute = createHttpExecutor({ baseUrl: 'http://api/admin', authHeaders: {}, fetchImpl });
    const result = execute({ id: '1', name: 'list_tables', input: {} }, controller.signal);
    await begun; controller.abort();
    expect(await result).toMatchObject({ isError: true, result: { error: 'cancelled' } });
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
