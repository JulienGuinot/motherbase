import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import '../lib/express-async-errors';

function appWith(...handlers: express.RequestHandler[]) {
  const app = express();
  app.get('/', ...handlers);
  app.use(((err, _req, res, _next) => res.status(500).json({ error: String(err) })) as express.ErrorRequestHandler);
  return app;
}

describe('express async errors', () => {
  it('sends a rejected async route to the error handler instead of hanging', async () => {
    const res = await request(appWith(async () => { throw new Error('boom'); })).get('/').timeout(2000);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Error: boom');
  });

  it('does the same for an async middleware ahead of the route', async () => {
    const app = appWith(async () => { throw new Error('guard'); }, (_req, res) => { res.send('unreachable'); });
    const res = await request(app).get('/').timeout(2000);
    expect(res.body.error).toBe('Error: guard');
  });

  // next(undefined) would mean "carry on" and hang the request all over again.
  it('turns a rejection with no reason into an error', async () => {
    const res = await request(appWith(() => Promise.reject(undefined))).get('/').timeout(2000);
    expect(res.status).toBe(500);
  });

  it('forwards a rejection from an async error handler', async () => {
    const app = express();
    app.get('/', () => { throw new Error('first'); });
    // Four parameters, or Express does not treat it as an error handler.
    app.use((async (_err: unknown, _req: unknown, _res: unknown, _next: unknown) => {
      throw new Error('second');
    }) as unknown as express.ErrorRequestHandler);
    app.use(((err, _req, res, _next) => res.status(500).send(String(err))) as express.ErrorRequestHandler);
    const res = await request(app).get('/').timeout(2000);
    expect(res.text).toBe('Error: second');
  });

  // The patch only exists if each process imports it; nothing else would notice it gone.
  it.each(['app.ts', 'console/server.ts', 'console/orchestration/app.ts'])('is installed by %s', file => {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    expect(source).toMatch(/^import '(\.\.\/)*(\.\/)?lib\/express-async-errors';$/m);
  });
});
