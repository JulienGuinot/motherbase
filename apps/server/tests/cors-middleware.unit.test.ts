import express from 'express';
import cors from 'cors';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCorsOptions,
  createCorsOptionsDelegate,
  parseCorsOrigins,
  resetCorsDecisionLog,
  resolveCorsOrigin,
} from '../middlewares/cors.middleware';
import { logBuffer } from '../models';

describe('CORS middleware settings', () => {
  it('parses comma-separated origins', () => {
    expect(parseCorsOrigins(' https://app.example.com, http://localhost:3000 ,, ')).toEqual([
      'https://app.example.com',
      'http://localhost:3000',
    ]);
  });

  it('treats * as allow all and lets cors reflect the request origin', async () => {
    const app = express();
    app.use(
      cors(
        createCorsOptionsDelegate(async () => ({
          origins: '*',
          credentials: true,
        }))
      )
    );
    app.post('/rest/v1/todo', (_req, res) => res.status(201).json({ ok: true }));

    const res = await request(app)
      .options('/rest/v1/todo')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('uses exact-origin allowlists when * is absent', () => {
    expect(resolveCorsOrigin('http://localhost:3000', 'https://app.example.com,http://localhost:3000')).toBe(
      'http://localhost:3000'
    );
    expect(resolveCorsOrigin('http://localhost:4000', 'https://app.example.com,http://localhost:3000')).toBe(false);
  });

  it('falls back to env-style settings without returning a CORS error', async () => {
    const app = express();
    app.use(
      cors(
        createCorsOptionsDelegate(
          async () => {
            throw new Error('settings table unavailable');
          },
          () => ({ origins: '*', credentials: true })
        )
      )
    );
    app.post('/rest/v1/todo', (_req, res) => res.status(201).json({ ok: true }));

    const res = await request(app)
      .options('/rest/v1/todo')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('keeps credentials configurable from settings', () => {
    expect(buildCorsOptions('https://app.example.com', { origins: '*', credentials: false }).credentials).toBe(false);
  });

  it('bounds the denied-origin memory against a stream of distinct origins', () => {
    resetCorsDecisionLog();
    const spy = vi.spyOn(logBuffer, 'push');
    try {
      const settings = { origins: 'https://app.example.com', credentials: true };
      for (let i = 0; i < 1200; i++) buildCorsOptions(`https://evil-${i}.example.com`, settings);
      // Every distinct origin warned once; the dedupe set restarted instead of growing.
      expect(spy).toHaveBeenCalledTimes(1200);
      buildCorsOptions('https://evil-1199.example.com', settings);
      expect(spy).toHaveBeenCalledTimes(1200);
    } finally {
      spy.mockRestore();
      resetCorsDecisionLog();
    }
  });

  it('never logs allowed decisions, warns once per denied origin', () => {
    resetCorsDecisionLog();
    const spy = vi.spyOn(logBuffer, 'push');
    try {
      const settings = { origins: 'https://app.example.com', credentials: true };

      // Allowed requests (incl. same-origin "(no origin)") produce no log noise.
      buildCorsOptions('https://app.example.com', settings);
      buildCorsOptions('https://app.example.com', settings);
      buildCorsOptions(undefined, settings);
      expect(spy).not.toHaveBeenCalled();

      // A denied origin warns exactly once, then is deduped.
      buildCorsOptions('https://evil.example.com', settings);
      buildCorsOptions('https://evil.example.com', settings);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }));

      // A different denied origin is a new decision and warns once more.
      buildCorsOptions('https://other-evil.example.com', settings);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      resetCorsDecisionLog();
    }
  });
});
