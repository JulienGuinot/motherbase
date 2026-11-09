import express from 'express';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toDenoSpecifiers } from '../services/admin/edge-sandbox';

// Runs against the Deno sidecar vitest.global-setup.ts starts. No Postgres.

describe('toDenoSpecifiers', () => {
  it('prefixes bare packages with npm: and Node builtins with node:', () => {
    const code = [
      "import { z } from 'zod';",
      'import {',
      '  createHash,',
      '} from "crypto";',
      "import '@scope/side-effect';",
      "export { thing } from 'lodash/fp';",
    ].join('\n');
    expect(toDenoSpecifiers(code)).toBe(
      [
        "import { z } from 'npm:zod';",
        'import {',
        '  createHash,',
        '} from "node:crypto";',
        "import 'npm:@scope/side-effect';",
        "export { thing } from 'npm:lodash/fp';",
      ].join('\n')
    );
  });

  it('leaves relative, prefixed and URL specifiers alone', () => {
    const code = [
      "import a from './a.ts';",
      "import b from '../_shared/b.ts';",
      "import c from 'npm:stripe@14';",
      "import d from 'jsr:@std/encoding@1';",
      "import e from 'https://esm.sh/preact';",
      "import f from 'node:path';",
    ].join('\n');
    expect(toDenoSpecifiers(code)).toBe(code);
  });

  it('does not touch strings that are not import statements', () => {
    const code = `export default () => new Response('import from "zod"');`;
    expect(toDenoSpecifiers(code)).toBe(code);
  });
});

describe('sendMail bridge', () => {
  const sent: unknown[] = [];
  let server: ReturnType<ReturnType<typeof express>['listen']>;
  let sandbox: typeof import('../services/admin/edge-sandbox');

  beforeAll(async () => {
    // The sidecar calls the API back, so the test plays the API: the same
    // route app.ts mounts, on a real port.
    // The handler is bound late: the module is re-imported below so it reads
    // this server's URL, and the route must use that same module's tokens.
    const app = express();
    app.use(express.json());
    app.post('/internal/edge-runtime/mail', (req, res) => sandbox.handleEdgeMailCallback(req, res));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));

    process.env.EDGE_RUNTIME_CALLBACK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.resetModules();
    sandbox = await import('../services/admin/edge-sandbox');
  });

  afterAll(() => {
    server?.close();
    delete process.env.EDGE_RUNTIME_CALLBACK_URL;
  });

  it('delivers through the host mailer, and hands validation errors back as a catchable throw', async () => {
    const code = `export default async () => {
      await sendMail({ to: 'sales@example.com', subject: 'New lead', text: 'body' });
      try { await sendMail({ to: 'not-an-address', subject: 's', text: 't' }); }
      catch (e) { return Response.json({ caught: e.message }); }
      return new Response('not thrown');
    };`;
    const result = await sandbox.runInSandbox(code, {}, {}, {
      request: {},
      sendMail: async options => {
        sent.push(options);
      },
    });

    expect(result.error).toBeNull();
    expect(JSON.parse(result.response!.body)).toEqual({ caught: 'sendMail: a valid `to` address is required' });
    expect(sent).toEqual([{ to: 'sales@example.com', subject: 'New lead', text: 'body', html: undefined }]);
  }, 60_000);

  it('accepts the token during its invocation and refuses it afterwards', async () => {
    const post = (token: string) =>
      fetch(`${process.env.EDGE_RUNTIME_CALLBACK_URL}${sandbox.EDGE_MAIL_CALLBACK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-edge-mail-token': token },
        body: JSON.stringify({ to: 'a@b.co', subject: 's', text: 't' }),
      });
    let token = '';
    // Stands in for the sidecar, to hold on to the token the way leaked code would.
    const runtime = {
      run: async (_code: string, _context: unknown, _env: unknown, options: { mail?: { token: string } }) => {
        token = options.mail!.token;
        return { value: (await post(token)).status, stdout: '', error: null, durationMs: 0 };
      },
    } as any;

    const result = await sandbox.runInSandbox('1', {}, {}, { sendMail: async () => {}, runtime });

    expect(result.value).toBe(200);
    expect((await post(token)).status).toBe(401);
  });
});
