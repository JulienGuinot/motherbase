import { describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import path from 'node:path';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const password = 'a"quoted\\password';

async function runSmoke(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  try {
    return await new Promise<{ code: number; output: string }>(resolve => {
      execFile(bash, [path.join(__dirname, 'vps-smoke.sh').replaceAll('\\', '/')], {
        env: {
          ...process.env, CONSOLE_URL: `http://127.0.0.1:${address.port}`,
          PROJECT: 'release-smoke', ADMIN_EMAIL: 'smoke@example.com', ADMIN_PASSWORD: password,
        }, timeout: 15000, windowsHide: true,
      }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, output: stdout + stderr }));
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('VPS smoke checks', () => {
  it('escapes credentials and only reads an existing fixture project', async () => {
    const requests: string[] = [];
    let loginBody = '';
    const result = await runSmoke((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/platform/login') {
        req.on('data', chunk => { loginBody += String(chunk); });
        req.on('end', () => res.end('{}'));
      } else {
        res.end(JSON.stringify({ data: req.url === '/api/platform/projects' ? [{ name: 'release-smoke' }] : {} }));
      }
    });
    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(loginBody)).toEqual({ email: 'smoke@example.com', password });
    expect(requests.filter(request => !request.startsWith('GET '))).toEqual(['POST /api/platform/login']);
    expect(result.output).not.toContain(password);
  });
  it('fails immediately on a rejected login without probing admin endpoints or logging the body', async () => {
    const requests: string[] = [];
    const result = await runSmoke((req, res) => {
      requests.push(req.url || '');
      res.writeHead(401).end('sensitive-response-body');
    });
    expect(result.code).toBe(1);
    expect(requests).toEqual(['/api/platform/login']);
    expect(result.output).not.toContain('sensitive-response-body');
  });
  it('fails on a missing fixture instead of creating a project', async () => {
    const requests: string[] = [];
    const result = await runSmoke((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader('Content-Type', 'application/json');
      res.end('{"data":[]}');
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('Dedicated smoke project missing');
    expect(requests).not.toContain('POST /api/platform/projects');
  });
});
