import { describe, expect, it, vi } from 'vitest';
import AiController from '../controllers/ai.controller';

// ThreadStore.getThread/renameThread/deleteThread take a bare thread id with
// no ownership check of their own (see ai-thread-store.sqlite.ts). The
// controller is the only thing standing between "any signed-in user" and
// "read/rename/delete anyone's conversation by guessing an id", so every one
// of those routes must be proven to refuse a foreign thread, not just getThread.

function makeThread(overrides: Partial<{ project: string; userId: string }> = {}) {
  return {
    id: 'thread-1',
    project: 'demo',
    userId: 'owner',
    title: 'Mine',
    createdAt: 'now',
    updatedAt: 'now',
    pending: null,
    messages: [],
    ...overrides,
  };
}

function makeDi(thread: ReturnType<typeof makeThread> | null) {
  const getThread = vi.fn().mockResolvedValue(thread);
  const renameThread = vi.fn().mockResolvedValue(undefined);
  const deleteThread = vi.fn().mockResolvedValue(undefined);
  const listThreads = vi.fn().mockResolvedValue([]);
  const di: any = {
    aiThreadStore: { getThread, renameThread, deleteThread, listThreads },
  };
  return { di, getThread, renameThread, deleteThread, listThreads };
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function reqAs(userId: string, id = 'thread-1', body?: unknown) {
  return { params: { id, project: 'demo' }, user: { id: userId }, body } as any;
}

describe('AiController thread ownership', () => {
  it('getThread returns the thread to its owner', async () => {
    const { di } = makeDi(makeThread({ userId: 'owner' }));
    const controller = new AiController(di);
    const res = makeRes();
    const next = vi.fn();

    await controller.getThread(reqAs('owner'), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('getThread refuses a thread owned by someone else', async () => {
    const { di } = makeDi(makeThread({ userId: 'owner' }));
    const controller = new AiController(di);
    const res = makeRes();
    const next = vi.fn();

    await controller.getThread(reqAs('attacker'), res, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0][0];
    expect(error.statusCode ?? error.status).toBe(404);
    expect(res.json).not.toHaveBeenCalled();
  });

  it('getThread refuses when the thread does not exist', async () => {
    const { di } = makeDi(null);
    const controller = new AiController(di);
    const res = makeRes();
    const next = vi.fn();

    await controller.getThread(reqAs('owner'), res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('rename refuses a thread owned by someone else, and never calls renameThread', async () => {
    const { di, renameThread } = makeDi(makeThread({ userId: 'owner' }));
    const controller = new AiController(di);
    const res = makeRes();
    const next = vi.fn();

    await controller.rename(reqAs('attacker', 'thread-1', { title: 'pwned' }), res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(renameThread).not.toHaveBeenCalled();
  });

  it('rename succeeds for the owner', async () => {
    const { di, renameThread } = makeDi(makeThread({ userId: 'owner' }));
    const controller = new AiController(di);
    const res = makeRes();
    const next = vi.fn();

    await controller.rename(reqAs('owner', 'thread-1', { title: 'New title' }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(renameThread).toHaveBeenCalledWith('thread-1', 'New title');
  });

  it('delete refuses a thread owned by someone else, and never calls deleteThread', async () => {
    const { di, deleteThread } = makeDi(makeThread({ userId: 'owner' }));
    const controller = new AiController(di);
    const res = makeRes();
    const next = vi.fn();

    await controller.remove(reqAs('attacker'), res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(deleteThread).not.toHaveBeenCalled();
  });

  it('delete succeeds for the owner', async () => {
    const { di, deleteThread } = makeDi(makeThread({ userId: 'owner' }));
    const controller = new AiController(di);
    const res = makeRes();
    const next = vi.fn();

    await controller.remove(reqAs('owner'), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(deleteThread).toHaveBeenCalledWith('thread-1');
  });

  it('also refuses a thread that belongs to a different project even for the same userId', async () => {
    const { di } = makeDi(makeThread({ userId: 'owner', project: 'other-project' }));
    const controller = new AiController(di);
    const res = makeRes();
    const next = vi.fn();

    await controller.getThread({ params: { id: 'thread-1', project: 'demo' }, user: { id: 'owner' } } as any, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

describe('AiController.chat credential handling', () => {
  it("forwards the caller's own bearer token to AiChatService, never a fallback token", async () => {
    const chatSpy = vi.fn(async function* (_input: { authHeaders: Record<string, string>; adminBaseUrl: string }) {
      yield { type: 'done', stopReason: 'end_turn' };
    });
    const di: any = { AiChatService: { chat: chatSpy } };
    const controller = new AiController(di);
    const res: any = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    const req: any = {
      headers: { authorization: 'Bearer caller-token', host: 'localhost' },
      params: {},
      user: { id: 'u1' },
      body: { message: 'hi' },
      on: vi.fn(),
      protocol: 'http',
    };

    await controller.chat(req, res);

    expect(chatSpy).toHaveBeenCalledOnce();
    const args = chatSpy.mock.calls[0]![0];
    expect(args.authHeaders).toEqual({ Authorization: 'Bearer caller-token' });
    // Loopback, not the request Host: behind the Console the Host header is the
    // Console's, where /api/admin/* does not exist.
    expect(args.adminBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/admin$/);
  });

  it('forwards the platform token when the Console proxy stripped Authorization', async () => {
    const chatSpy = vi.fn(async function* (_input: { authHeaders: Record<string, string> }) {
      yield { type: 'done', stopReason: 'end_turn' };
    });
    const di: any = { AiChatService: { chat: chatSpy } };
    const controller = new AiController(di);
    const res: any = { setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn() };
    const req: any = {
      headers: { 'x-platform-token': 'plat', host: 'console.example' },
      params: {},
      user: { id: 'u1' },
      body: { message: 'hi' },
      on: vi.fn(),
      protocol: 'https',
    };

    await controller.chat(req, res);

    expect(chatSpy.mock.calls[0]![0].authHeaders).toEqual({ 'X-Platform-Token': 'plat' });
  });

  it('does not substitute any credential when no auth header is present', async () => {
    const chatSpy = vi.fn(async function* (_input: { authHeaders: Record<string, string> }) {
      yield { type: 'done', stopReason: 'end_turn' };
    });
    const di: any = { AiChatService: { chat: chatSpy } };
    const controller = new AiController(di);
    const res: any = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    const req: any = {
      headers: { host: 'localhost' },
      params: {},
      user: { id: 'u1' },
      body: { message: 'hi' },
      on: vi.fn(),
      protocol: 'http',
    };

    await controller.chat(req, res);

    const args = chatSpy.mock.calls[0]![0];
    expect(args.authHeaders).toEqual({});
  });

  it('never writes the resolved AI config (and its decrypted api key) into an SSE frame', async () => {
    const secretConfig = { apiKey: 'super-secret-key', provider: 'anthropic', model: 'm' };
    const chatSpy = vi.fn(async function* () {
      // A buggy chat service might be tempted to surface the config for
      // debugging; simulate a message that happens to mention the key to
      // prove the controller doesn't do any independent serialization that
      // could leak it (it only JSON.stringifies whatever the service yields).
      yield { type: 'text_delta', text: 'hello' };
      yield { type: 'done', stopReason: 'end_turn' };
      void secretConfig;
    });
    const di: any = { AiChatService: { chat: chatSpy } };
    const controller = new AiController(di);
    const writes: string[] = [];
    const res: any = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn((chunk: string) => writes.push(chunk)),
      end: vi.fn(),
    };
    const req: any = {
      headers: { authorization: 'Bearer tok', host: 'localhost' },
      params: {},
      user: { id: 'u1' },
      body: { message: 'hi' },
      on: vi.fn(),
      protocol: 'http',
    };

    await controller.chat(req, res);

    expect(writes.join('')).not.toContain('super-secret-key');
  });
});

describe('AiController.resolve', () => {
  function makeSseRes() {
    const writes: string[] = [];
    return {
      res: {
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn((chunk: string) => writes.push(chunk)),
        end: vi.fn(),
      } as any,
      writes,
    };
  }

  it('rejects a decisions body that is not a plain id -> boolean map, before calling the service', async () => {
    const resolveSpy = vi.fn();
    const di: any = { AiChatService: { resolve: resolveSpy } };
    const controller = new AiController(di);
    const { res, writes } = makeSseRes();
    const req: any = {
      headers: { authorization: 'Bearer tok', host: 'localhost' },
      params: { id: 'thread-1' },
      user: { id: 'u1' },
      body: { decisions: ['not', 'a', 'map'] },
      on: vi.fn(),
      protocol: 'http',
    };

    await controller.resolve(req, res);

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(writes.join('')).toContain('decisions must be a map');
  });

  it('coerces truthy/falsy decision values to booleans and forwards the caller credential', async () => {
    const resolveSpy = vi.fn(async function* (_input: { authHeaders: Record<string, string>; decisions: Record<string, boolean>; threadId: string }) {
      yield { type: 'done', stopReason: 'end_turn' };
    });
    const di: any = { AiChatService: { resolve: resolveSpy } };
    const controller = new AiController(di);
    const { res } = makeSseRes();
    const req: any = {
      headers: { authorization: 'Bearer caller-token', host: 'localhost' },
      params: { id: 'thread-1' },
      user: { id: 'u1' },
      body: { decisions: { w1: true, w2: 0 } },
      on: vi.fn(),
      protocol: 'http',
    };

    await controller.resolve(req, res);

    expect(resolveSpy).toHaveBeenCalledOnce();
    const args = resolveSpy.mock.calls[0]![0];
    expect(args.decisions).toEqual({ w1: true, w2: false });
    expect(args.threadId).toBe('thread-1');
    expect(args.authHeaders).toEqual({ Authorization: 'Bearer caller-token' });
  });
});
