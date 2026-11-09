import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

// A fresh temp projects dir per test so the console-auth SQLite store is
// isolated. Env is set before importing the module (config.ts reads it at load).
function freshDir() {
  const dir = path.join(os.tmpdir(), `console-srv-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function loadApp(dir: string, trustProxy?: string) {
  process.env.CONSOLE_MODE = 'dev';
  process.env.PROJECTS_DIR = dir;
  process.env.CONSOLE_JWT_SECRET = 'test-secret';
  process.env.CONSOLE_ADMIN_EMAIL = 'admin@example.com';
  process.env.CONSOLE_ADMIN_PASSWORD_HASH = bcrypt.hashSync('pw12345', 8);
  if (trustProxy === undefined) {
    Reflect.deleteProperty(process.env, 'TRUST_PROXY');
  } else {
    process.env.TRUST_PROXY = trustProxy;
  }
  vi.resetModules();
  const { createConsoleApp } = await import('../console/server');
  return createConsoleApp({ registry: { list: vi.fn().mockResolvedValue([]) }, orchestrator: {} } as any);
}

// Booting the console app is what costs: `loadApp` imports the server module,
// migrates the SQLite auth store and initialises Better Auth, and the cases that
// log in also pay for bcrypt. That fits in vitest's 5 s default on an idle
// machine and does not inside the full suite, where this file is one of ~280
// worker processes -- `npm run verify` timed out here on two consecutive runs
// and every case passed when the file was run alone. Set on the suite rather
// than on the case that happened to lose the race first. Same value as the
// other slow integration suites (`integration-webhooks`, `edge-runtime`).
const SLOW = 60_000;

describe('console server', { timeout: SLOW }, () => {
  let dir: string;
  beforeEach(() => { dir = freshDir(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* db handle open */ } });

  // The first request mounts the studio, which compiles Next on a cold machine.
  it('redirects the former console root to the studio mount', async () => {
    const app = await loadApp(dir);

    const response = await request(app).get('/').redirects(0);

    expect(response.status).toBe(308);
    expect(response.headers.location).toBe('/studio');
  });

  it('preserves the path and query when redirecting off the former root', async () => {
    const app = await loadApp(dir);

    const response = await request(app).get('/team?tab=members').redirects(0);

    expect(response.status).toBe(308);
    expect(response.headers.location).toBe('/studio/team?tab=members');
  });

  it('redirects the legacy /console mount to the studio mount', async () => {
    const app = await loadApp(dir);

    const response = await request(app).get('/console').redirects(0);

    expect(response.status).toBe(308);
    expect(response.headers.location).toBe('/studio');
  });

  it('forbids framing the console and sniffing its responses', async () => {
    const app = await loadApp(dir);

    const response = await request(app).get('/api/platform/projects').redirects(0);

    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('leaves the API out of the root redirect', async () => {
    const app = await loadApp(dir);

    const response = await request(app).get('/api/platform/projects').redirects(0);

    expect(response.status).toBe(401);
  });

  it('rejects platform calls without a session and accepts after login (cookie)', async () => {
    const app = await loadApp(dir);
    const agent = request.agent(app);

    const noauth = await agent.get('/api/platform/projects');
    expect(noauth.status).toBe(401);

    const login = await agent.post('/api/platform/login').send({ email: 'admin@example.com', password: 'pw12345' });
    expect(login.status).toBe(200);
    // Better Auth sets a session cookie (cookiePrefix 'console') AND returns the
    // bearer token in the body (the console UI stores it).
    expect(String(login.headers['set-cookie'] ?? '')).toContain('console');
    expect(login.body.data.token).toBeTruthy();

    const ok = await agent.get('/api/platform/projects');
    expect(ok.status).toBe(200);

    // The returned token also authorizes as a bearer (what the UI actually sends).
    const viaBearer = await request(app).get('/api/platform/projects').set('Authorization', `Bearer ${login.body.data.token}`);
    expect(viaBearer.status).toBe(200);
  });

  it('accepts a proxied production login when the trusted hop is configured', async () => {
    const app = await loadApp(dir, '1');

    const login = await request(app)
      .post('/api/platform/login')
      .set('X-Forwarded-For', '203.0.113.10')
      .send({ email: 'admin@example.com', password: 'pw12345' });

    expect(login.status).toBe(200);
    expect(login.body.data.token).toBeTruthy();
  });
  it('rejects login with a wrong password', async () => {
    const app = await loadApp(dir);
    const bad = await request(app).post('/api/platform/login').send({ email: 'admin@example.com', password: 'nope' });
    expect(bad.status).toBe(401);
  });

  it('authorizes a guarded route with a Better Auth bearer token (CLI path)', async () => {
    const app = await loadApp(dir);
    // Native BA sign-in returns a session token (bearer plugin) for non-browser clients.
    const signin = await request(app).post('/api/auth/sign-in/email').send({ email: 'admin@example.com', password: 'pw12345' });
    expect(signin.status).toBe(200);
    const token = signin.body.token || signin.headers['set-auth-token'];
    expect(token).toBeTruthy();

    const ok = await request(app).get('/api/platform/projects').set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);
  });
});
