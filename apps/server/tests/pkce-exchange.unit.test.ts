import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { pkceExchange } from '../auth/plugins/pkce-exchange';
import { PKCE_CODE_TTL_MS, createPkceCodec } from '../auth/pkce';

const SECRET = 'test-secret';
const verifier = 'v'.repeat(50);
const challenge = createHash('sha256').update(verifier).digest('base64url');

/**
 * `create` on a primary key, the way Postgres answers it: the duplicate loses
 * with P2002. The check and the insert are one synchronous step here for the
 * same reason they are one statement there — nothing may interleave between
 * them, which is the whole point of the claim.
 */
function fakePrisma() {
  const rows = new Map<string, Date>();
  return {
    rows,
    pkceCode: {
      create: vi.fn(async ({ data }: { data: { codeHash: string; expiresAt: Date } }) => {
        if (rows.has(data.codeHash)) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        rows.set(data.codeHash, data.expiresAt);
        return data;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { expiresAt: { lt: Date } } }) => {
        let count = 0;
        for (const [hash, expiresAt] of rows) {
          if (expiresAt < where.expiresAt.lt) { rows.delete(hash); count += 1; }
        }
        return { count };
      }),
    },
  };
}

function setup(prisma: any = fakePrisma(), now: () => number = Date.now) {
  const adapter = {
    findSession: vi.fn(async () => ({ session: { expiresAt: new Date(Date.now() + 60_000) }, user: { id: 'u1' } })),
  };
  const plugin = pkceExchange(prisma as any, now);
  const exchange = (code: string, codeVerifier: string) =>
    (plugin.endpoints.exchangeCode as any)({
      body: { auth_code: code, code_verifier: codeVerifier },
      context: { secret: SECRET, internalAdapter: adapter },
    });
  return { adapter, prisma, exchange };
}

describe('pkce-exchange', () => {
  it('rejects a wrong verifier without consuming the code or reading the session', async () => {
    const { adapter, prisma, exchange } = setup();
    const code = createPkceCodec(SECRET).mint('tok.sig', challenge, 's256');

    await expect(exchange(code, 'w'.repeat(50))).rejects.toThrow(/Invalid or expired PKCE code/);
    expect(prisma.pkceCode.create).not.toHaveBeenCalled();
    expect(adapter.findSession).not.toHaveBeenCalled();
  });

  it('exchanges a code with the right verifier for the session', async () => {
    const { exchange } = setup();
    const code = createPkceCodec(SECRET).mint('tok.sig', challenge, 's256');
    expect(await exchange(code, verifier)).toMatchObject({ token: 'tok.sig', user: { id: 'u1' } });
  });

  it('rejects a second exchange of the same code', async () => {
    const { exchange } = setup();
    const code = createPkceCodec(SECRET).mint('tok.sig', challenge, 's256');

    await exchange(code, verifier);
    await expect(exchange(code, verifier)).rejects.toThrow(/Invalid or expired PKCE code/);
  });

  // SEC-16: the claim was a read followed by a write, so two exchanges that
  // interleaved across that await both found no marker and both got a session.
  it('lets only one of two concurrent exchanges of the same code through', async () => {
    const { exchange } = setup();
    const code = createPkceCodec(SECRET).mint('tok.sig', challenge, 's256');

    const settled = await Promise.allSettled([exchange(code, verifier), exchange(code, verifier)]);

    expect(settled.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(r => r.status === 'rejected')).toHaveLength(1);
  });

  it('surfaces a database failure instead of reading it as an invalid code', async () => {
    const prisma = fakePrisma();
    prisma.pkceCode.create = vi.fn(async () => {
      throw Object.assign(new Error('connection terminated'), { code: 'P1001' });
    });
    const { exchange } = setup(prisma);
    const code = createPkceCodec(SECRET).mint('tok.sig', challenge, 's256');

    await expect(exchange(code, verifier)).rejects.toThrow(/connection terminated/);
  });

  // The marker only has to outlive the code behind it. Sweeping on exchange
  // keeps the table self-bounding without a scheduler, and without a config
  // switch that could be turned off while codes are still being minted.
  it('sweeps markers whose code can no longer be exchanged', async () => {
    const { prisma, exchange } = setup();
    const code = createPkceCodec(SECRET).mint('tok.sig', challenge, 's256');

    await exchange(code, verifier);

    expect(prisma.pkceCode.deleteMany).toHaveBeenCalledTimes(1);
    const { where } = prisma.pkceCode.deleteMany.mock.calls[0][0];
    expect(where.expiresAt.lt).toBeInstanceOf(Date);
  });

  it('sweeps at most once per code lifetime', async () => {
    let clock = 1_000_000;
    const { prisma, exchange } = setup(fakePrisma(), () => clock);
    const codec = createPkceCodec(SECRET);

    await exchange(codec.mint('a.sig', challenge, 's256'), verifier);
    await exchange(codec.mint('b.sig', challenge, 's256'), verifier);
    expect(prisma.pkceCode.deleteMany).toHaveBeenCalledTimes(1);

    clock += PKCE_CODE_TTL_MS + 1;
    await exchange(codec.mint('c.sig', challenge, 's256'), verifier);
    expect(prisma.pkceCode.deleteMany).toHaveBeenCalledTimes(2);
  });

  it('exchanges the code even when the sweep fails', async () => {
    const prisma = fakePrisma();
    prisma.pkceCode.deleteMany = vi.fn(async () => {
      throw new Error('deadlock detected');
    });
    const { exchange } = setup(prisma);
    const code = createPkceCodec(SECRET).mint('tok.sig', challenge, 's256');

    expect(await exchange(code, verifier)).toMatchObject({ token: 'tok.sig' });
  });
});
