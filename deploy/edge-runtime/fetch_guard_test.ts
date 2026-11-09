import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { createGuardedFetch, isPrivateIp, parseAllowedOrigins, v6ToBytes, v4ToInt } from './fetch_guard.ts';

Deno.test('isPrivateIp blocks the ranges the Node helper blocks', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0']) {
    assert(isPrivateIp(ip), `${ip} must be blocked`);
  }
  for (const ip of ['::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert(isPrivateIp(ip), `${ip} must be blocked`);
  }
});

Deno.test('isPrivateIp allows public unicast', () => {
  assertEquals(isPrivateIp('1.1.1.1'), false);
  assertEquals(isPrivateIp('93.184.216.34'), false);
  assertEquals(isPrivateIp('2606:4700::1111'), false);
});

Deno.test('a name resolving to a private address is refused (DNS rebinding)', async () => {
  const guarded = createGuardedFetch({
    allowedOrigins: new Set(),
    resolve: () => Promise.resolve(['169.254.169.254']),
  });
  await assertRejects(
    () => guarded('http://metadata.example.com/latest/meta-data/'),
    Error,
    'metadata.example.com',
  );
});

Deno.test('an allowlisted origin skips the private-address check', async () => {
  let requested: string | null = null;
  const guarded = createGuardedFetch({
    allowedOrigins: parseAllowedOrigins('http://api:5001'),
    resolve: () => Promise.resolve(['172.18.0.4']),
    // deno-lint-ignore no-explicit-any
    transport: ((url: string) => {
      requested = String(url);
      return Promise.resolve(new Response('ok'));
    }) as any,
  });
  const response = await guarded('http://api:5001/rest/v1/todos');
  assertEquals(response.status, 200);
  assertEquals(requested, 'http://api:5001/rest/v1/todos');
});

Deno.test('the allowlist matches an exact origin, never a suffix', () => {
  const allowed = parseAllowedOrigins('http://api:5001');
  assert(allowed.has(new URL('http://api:5001/anything').origin));
  assert(!allowed.has(new URL('http://api.evil.com/').origin));
  assert(!allowed.has(new URL('http://api:5002/').origin));
  assert(!allowed.has(new URL('https://api:5001/').origin));
});

Deno.test('non-http schemes are refused', async () => {
  const guarded = createGuardedFetch({ allowedOrigins: new Set() });
  await assertRejects(() => guarded('file:///etc/passwd'), Error, 'http or https');
});

Deno.test('IPv4-mapped IPv6 addresses with hex form (::ffff:7f00:1) are blocked', () => {
  assert(isPrivateIp('::ffff:7f00:1'), '::ffff:7f00:1 (127.0.0.1) must be blocked');
  assert(isPrivateIp('::ffff:a00:1'), '::ffff:a00:1 (10.0.0.1) must be blocked');
  assert(isPrivateIp('::ffff:c0a8:1'), '::ffff:c0a8:1 (192.168.0.1) must be blocked');
});

Deno.test('IPv4-mapped IPv6 end-to-end guard blocks hex form', async () => {
  const guarded = createGuardedFetch({
    allowedOrigins: new Set(),
    resolve: () => Promise.resolve(['::ffff:7f00:1']),
  });
  await assertRejects(
    () => guarded('http://loopback.example.com/'),
    Error,
    'loopback.example.com',
  );
});

Deno.test('malformed IPv6 with too many groups returns null from parser', () => {
  assertEquals(v6ToBytes('1:2:3:4:5:6:7:8:9::10'), null, 'malformed IPv6 must be rejected by v6ToBytes, not throw');
});

Deno.test('IPv6 with multiple :: returns null from parser', () => {
  assertEquals(v6ToBytes('fc00::1::2'), null, 'multiple :: in IPv6 must be rejected by v6ToBytes');
});

Deno.test('multicast and reserved boundary cases are blocked correctly', () => {
  assert(isPrivateIp('224.0.0.0'), '224.0.0.0 (class D) must be blocked');
  assert(isPrivateIp('224.0.0.1'), '224.0.0.1 (class D) must be blocked');
  assert(isPrivateIp('239.255.255.255'), '239.255.255.255 (class D) must be blocked');
  assert(isPrivateIp('240.0.0.1'), '240.0.0.1 (class E) must be blocked');
  assertEquals(isPrivateIp('223.255.255.255'), false, '223.255.255.255 must be allowed');
});

Deno.test('redirects are refused after transport returns them', async () => {
  let transportCalled = false;
  const guarded = createGuardedFetch({
    allowedOrigins: new Set(),
    resolve: () => Promise.resolve(['93.184.216.34']),
    // deno-lint-ignore no-explicit-any
    transport: (() => {
      transportCalled = true;
      return Promise.resolve(new Response(null, {
        status: 302,
        headers: { location: 'http://evil.example.com/' },
      }));
    }) as any,
  });
  await assertRejects(
    () => guarded('http://good.example.com/redirect'),
    Error,
    '302',
  );
  assertEquals(transportCalled, true, 'transport must be called and then the redirect refused');
});

Deno.test('redirect to private address is refused with target hostname', async () => {
  const guarded = createGuardedFetch({
    allowedOrigins: new Set(),
    resolve: () => Promise.resolve(['93.184.216.34']),
    // deno-lint-ignore no-explicit-any
    transport: (() => {
      return Promise.resolve(new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/metadata' },
      }));
    }) as any,
  });
  await assertRejects(
    () => guarded('http://good.example.com/'),
    Error,
    '169.254.169.254',
  );
});

Deno.test('allowlisted origins are still subject to redirect checks', async () => {
  const guarded = createGuardedFetch({
    allowedOrigins: parseAllowedOrigins('http://api:5001'),
    // deno-lint-ignore no-explicit-any
    transport: (() => {
      return Promise.resolve(new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/metadata' },
      }));
    }) as any,
  });
  await assertRejects(
    () => guarded('http://api:5001/request'),
    Error,
    '302',
  );
});

Deno.test('real server redirect to private address is refused (integration test)', async () => {
  // Start a real server that redirects to a private address.
  // This tests the actual runtime behavior, not just the logic with stubbed responses.
  // We allowlist the loopback origin so the address check passes, proving the
  // redirect check fires. This is the exact laundering path the allowlist finding
  // was about.
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0 }, () => {
    return new Response(null, {
      status: 302,
      headers: { location: 'http://169.254.169.254/metadata' },
    });
  });

  try {
    const addr = server.addr as Deno.NetAddr;
    const origin = `http://127.0.0.1:${addr.port}`;

    const guarded = createGuardedFetch({
      allowedOrigins: parseAllowedOrigins(origin),
    });

    await assertRejects(
      () => guarded(`${origin}/request`),
      Error,
      '302',
    );
  } finally {
    await server.shutdown();
  }
});
