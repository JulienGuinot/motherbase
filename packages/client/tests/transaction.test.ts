import { describe, it, expect, vi } from 'vitest';
import { createClient } from '../src/index.js';
import { memoryStorage } from '../src/auth/session.js';

/**
 * The client half of a transaction: what it puts on the wire, and what it
 * refuses to send. The atomicity itself is the server's, asserted by the REST
 * integration suite.
 */

function client(response: { status: number; body: unknown } = { status: 200, body: { status: 1, data: { results: [] } } }) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const impl = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  const c = createClient('http://api.test', undefined, {
    storage: memoryStorage(),
    fetch: impl as unknown as typeof fetch,
  });
  return { c, calls };
}

describe('client.transaction', () => {
  it('sends every declared write as one batch, in order', async () => {
    const { c, calls } = client({ status: 200, body: { status: 1, data: { results: [[{ id: 'o1' }], []] } } });

    const { data, error } = await c.transaction(tx => {
      tx.from('orders').insert({ id: 'o1' });
      tx.from('stock').update({ count: 4 }).eq('sku', 'abc');
    });

    expect(error).toBeNull();
    expect(data).toEqual([[{ id: 'o1' }], []]);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('http://api.test/rest/v1/batch');
    expect(calls[0].body).toEqual({
      operations: [
        { method: 'POST', model: 'orders', query: {}, body: { id: 'o1' } },
        { method: 'PATCH', model: 'stock', query: { sku: ['eq.abc'] }, body: { count: 4 } },
      ],
    });
  });

  it('refuses a read, which a batch cannot order meaningfully', async () => {
    const { c, calls } = client();

    const { error } = await c.transaction(tx => {
      tx.from('orders').select('*');
    });

    expect(error?.message).toMatch(/writes only/);
    expect(calls).toHaveLength(0);
  });

  it('refuses an empty transaction rather than sending one', async () => {
    const { c, calls } = client();

    const { error } = await c.transaction(() => {});

    expect(error?.message).toMatch(/no writes/);
    expect(calls).toHaveLength(0);
  });

  it('keeps repeated filters on one column as two conditions', async () => {
    const { c, calls } = client();

    await c.transaction(tx => {
      tx.from('t').delete().gt('price', 10).lt('price', 20);
    });

    expect((calls[0].body as any).operations[0].query).toEqual({ price: ['gt.10', 'lt.20'] });
  });

  it('surfaces a server failure as an error, not as a throw', async () => {
    const { c } = client({ status: 400, body: { status: 0, message: 'A batch needs at least one operation.' } });

    const { data, error } = await c.transaction(tx => {
      tx.from('t').insert({ a: 1 });
    });

    expect(data).toBeNull();
    expect(error?.message).toMatch(/batch/);
  });
});

describe('transaction safety', () => {
  it.each(['rollback', 'maxAffected', 'upsert', 'header'] as const)('refuses unsupported %s before sending any write', async option => {
    const { c, calls } = client();
    const { error } = await c.transaction(tx => {
      const query = tx.from('t').delete();
      if (option === 'rollback') query.rollback();
      if (option === 'maxAffected') query.maxAffected(1);
      if (option === 'upsert') query.upsert({ id: 1 });
      if (option === 'header') query.setHeader('x-test', 'value');
    });
    expect(error?.message).toMatch(/not supported/);
    expect(calls).toHaveLength(0);
  });

  it('rejects awaiting a transaction operation without sending the batch or an individual write', async () => {
    const { c, calls } = client();
    const { error } = await c.transaction(async tx => {
      await tx.from('t').insert({ id: 1 });
    });
    expect(error?.message).toMatch(/do not await/);
    expect(calls).toHaveLength(0);
  });

  it('does not leave a captured transaction builder executable after completion', async () => {
    const { c, calls } = client();
    let saved!: PromiseLike<unknown>;
    await c.transaction(tx => { saved = tx.from('t').insert({ id: 1 }); });
    await expect(Promise.resolve(saved)).rejects.toThrow(/do not await/);
    expect(calls).toHaveLength(1);
  });
});
