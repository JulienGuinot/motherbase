import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSseChunk, streamChat } from './assistant.api';
import { ensureAccessToken, refreshAccessToken } from '@/shared/lib/api';

// The stream cannot go through the axios instance (SSE), so it repeats the
// interceptor's refresh-and-replay itself. Stub the two helpers it borrows.
vi.mock('@/shared/lib/api', () => ({
  api: {},
  withProjectPrefix: (url: string) => url,
  ensureAccessToken: vi.fn(async () => 'access-1'),
  refreshAccessToken: vi.fn(async () => 'access-2'),
}));

describe('parseSseChunk', () => {
  it('splits complete events and keeps the remainder buffered', () => {
    const out = parseSseChunk('data: {"type":"text_delta","text":"a"}\n\ndata: {"ty');
    expect(out.events).toEqual([{ type: 'text_delta', text: 'a' }]);
    expect(out.rest).toBe('data: {"ty');
  });

  it('ignores blank frames and unparseable payloads', () => {
    const out = parseSseChunk('\n\ndata: not json\n\n');
    expect(out.events).toEqual([]);
    expect(out.rest).toBe('');
  });

  it('parses frames delimited with CRLF line endings', () => {
    const out = parseSseChunk('data: {"type":"text_delta","text":"a"}\r\n\r\n');
    expect(out.events).toEqual([{ type: 'text_delta', text: 'a' }]);
    expect(out.rest).toBe('');
  });
});

describe('streamChat', () => {
  // Call counts only: the default implementations above stay in place.
  beforeEach(() => vi.clearAllMocks());

  it('calls back once per event and stops at done', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode('data: {"type":"thread","threadId":"t1"}\n\n'));
        c.enqueue(enc.encode('data: {"type":"text_delta","text":"hi"}\n\n'));
        c.enqueue(enc.encode('data: {"type":"done","stopReason":"end_turn"}\n\n'));
        c.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body }) as never));

    const seen: unknown[] = [];
    await streamChat({ message: 'hi', context: { project: 'demo', route: '/' } }, e => seen.push(e));

    expect(seen.map((e: any) => e.type)).toEqual(['thread', 'text_delta', 'done']);
    vi.unstubAllGlobals();
  });

  it('surfaces a failed request as an error event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' }) as never),
    );

    const seen: any[] = [];
    await streamChat({ message: 'hi', context: { project: 'demo', route: '/' } }, e => seen.push(e));

    expect(seen[0].type).toBe('error');
    expect(seen.at(-1)).toEqual({ type: 'done', stopReason: 'error' });
    vi.unstubAllGlobals();
  });

  it('emits a final frame that arrives with no trailing blank line', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode('data: {"type":"thread","threadId":"t1"}\n\n'));
        // No trailing "\n\n" after this last frame before the stream closes.
        c.enqueue(enc.encode('data: {"type":"done","stopReason":"end_turn"}'));
        c.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body }) as never));

    const seen: any[] = [];
    await streamChat({ message: 'hi', context: { project: 'demo', route: '/' } }, e => seen.push(e));

    expect(seen.map(e => e.type)).toEqual(['thread', 'done']);
    expect(seen.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
    vi.unstubAllGlobals();
  });

  it('ends quietly on an aborted read: no error event, just done', async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    const fakeReader = { read: vi.fn(async () => { throw abortError; }), releaseLock: vi.fn() };
    const body = { getReader: () => fakeReader };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body }) as never));

    const seen: any[] = [];
    await streamChat(
      { message: 'hi', context: { project: 'demo', route: '/' } },
      e => seen.push(e),
      controller.signal,
    );

    expect(seen).toEqual([{ type: 'done', stopReason: 'aborted' }]);
    expect(fakeReader.releaseLock).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('refreshes and replays once on a 401 instead of reporting "Request failed (401)"', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"type":"done","stopReason":"end_turn"}\n\n'));
        c.close();
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'expired' } as never)
      .mockResolvedValueOnce({ ok: true, status: 200, body } as never);
    vi.stubGlobal('fetch', fetchMock);

    const seen: any[] = [];
    await streamChat({ message: 'hi', context: { project: 'demo', route: '/' } }, e => seen.push(e));

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The replay carries the fresh token, not the expired one.
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer access-1');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer access-2');
    expect(seen).toEqual([{ type: 'done', stopReason: 'end_turn' }]);
    vi.unstubAllGlobals();
  });

  it('does not replay a 401 when the session is really gone', async () => {
    vi.mocked(refreshAccessToken).mockResolvedValueOnce(null);
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'expired' }) as never);
    vi.stubGlobal('fetch', fetchMock);

    const seen: any[] = [];
    await streamChat({ message: 'hi', context: { project: 'demo', route: '/' } }, e => seen.push(e));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toEqual({ type: 'done', stopReason: 'error' });
    vi.unstubAllGlobals();
  });

  it('sends the token ensureAccessToken hands it', async () => {
    vi.mocked(ensureAccessToken).mockResolvedValueOnce(null);
    // vi.fn() with no signature, like the mock above: an inline arrow with no
    // parameters types mock.calls as an empty tuple and indexing it fails.
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' } as never);
    vi.stubGlobal('fetch', fetchMock);

    await streamChat({ message: 'hi', context: { project: 'demo', route: '/' } }, () => {});

    // No token, no Authorization header, not `Bearer null`.
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('surfaces a non-abort read failure as error then done, and still releases the reader', async () => {
    const controller = new AbortController();
    const readError = new Error('network reset');
    const fakeReader = { read: vi.fn(async () => { throw readError; }), releaseLock: vi.fn() };
    const body = { getReader: () => fakeReader };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body }) as never));

    const seen: any[] = [];
    await streamChat(
      { message: 'hi', context: { project: 'demo', route: '/' } },
      e => seen.push(e),
      controller.signal,
    );

    expect(seen).toEqual([
      { type: 'error', message: 'network reset' },
      { type: 'done', stopReason: 'error' },
    ]);
    expect(fakeReader.releaseLock).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
