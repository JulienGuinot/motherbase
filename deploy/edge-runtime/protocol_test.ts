import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { parseJob } from './protocol.ts';

Deno.test('parseJob fills defaults for an otherwise minimal job', () => {
  const job = parseJob({ code: 'export default () => 1', limits: { memoryLimitMb: 128, timeoutMs: 5000 } });
  assertEquals(job.context, {});
  assertEquals(job.env, {});
  assertEquals(job.request.method, 'POST');
  assertEquals(job.request.url, 'http://edge.local/');
});

Deno.test('parseJob rejects a job with no code', () => {
  assertThrows(
    () => parseJob({ limits: { memoryLimitMb: 128, timeoutMs: 5000 } }),
    Error,
    'code is required',
  );
});

Deno.test('parseJob rejects limits that are missing or not positive', () => {
  assertThrows(() => parseJob({ code: 'x' }), Error, 'limits.memoryLimitMb');
  assertThrows(
    () => parseJob({ code: 'x', limits: { memoryLimitMb: 0, timeoutMs: 5000 } }),
    Error,
    'limits.memoryLimitMb',
  );
});

Deno.test('parseJob validates multi-file source paths and entrypoint', () => {
  const source = {
    entrypointPath: 'index.ts',
    files: [{ path: 'index.ts', contentBase64: btoa('export default () => 1') }],
  };
  assertEquals(
    parseJob({ code: 'x', source, limits: { memoryLimitMb: 128, timeoutMs: 5000 } }).source,
    source,
  );
  assertThrows(
    () =>
      parseJob({
        code: 'x',
        source: { ...source, entrypointPath: '../index.ts' },
        limits: { memoryLimitMb: 128, timeoutMs: 5000 },
      }),
    Error,
    'invalid source path',
  );
});
