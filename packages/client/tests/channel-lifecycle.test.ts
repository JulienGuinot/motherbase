import { describe, expect, it, vi } from 'vitest';
import { RealtimeChannel } from '../src/realtime/channel.js';
import { RealtimeModule } from '../src/realtime/index.js';
import type { SocketLike } from '../src/realtime/types.js';
import { memoryStorage, SessionStore } from '../src/auth/session.js';

function transport(connect: () => Promise<void> = async () => {}) {
  return {
    connect, registerChannel: vi.fn(), unregisterChannel: vi.fn(), leaveTopic: vi.fn(),
    joinTopic: vi.fn(async () => ({ status: 'ok', bindingIds: true })),
  };
}

describe('channel lifecycle', () => {
  it('cannot join after unsubscribe while connecting', async () => {
    let connected!: () => void;
    const rt = transport(() => new Promise(resolve => { connected = resolve; }));
    const status = vi.fn();
    const channel = new RealtimeChannel('topic', rt as unknown as RealtimeModule);
    channel.subscribe(status);
    await channel.unsubscribe();
    connected();
    await Promise.resolve();
    expect(rt.registerChannel).not.toHaveBeenCalled();
    expect(rt.joinTopic).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith('CLOSED', undefined);
  });

  it('ignores a late join ack after unsubscribe and does not replay it on reconnect', async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    let ack!: (data: { status: 'ok' }) => void;
    const socket: SocketLike = {
      connected: true, on: (name, fn) => { handlers.set(name, fn); }, off: () => {}, disconnect: () => {},
      emit: vi.fn((name, ...args) => { if (name === 'rt:join') ack = args[1] as typeof ack; }),
    };
    const rt = new RealtimeModule('http://api.test', new SessionStore(memoryStorage()), fetch, () => socket);
    const status = vi.fn();
    const channel = new RealtimeChannel('topic', rt);
    channel.subscribe(status);
    await vi.waitFor(() => expect(ack).toBeDefined());
    await channel.unsubscribe();
    ack({ status: 'ok' });
    await Promise.resolve();
    expect((socket.emit as ReturnType<typeof vi.fn>).mock.calls.filter(([name]) => name === 'rt:leave')).toHaveLength(2);
    handlers.get('connect')?.();
    expect((socket.emit as ReturnType<typeof vi.fn>).mock.calls.filter(([name]) => name === 'rt:join')).toHaveLength(1);
    expect(status.mock.calls.some(([value]) => value === 'SUBSCRIBED')).toBe(false);
  });

  it('can subscribe again after cancelling a pending connection', async () => {
    let connected!: () => void;
    const pending = new Promise<void>(resolve => { connected = resolve; });
    const rt = transport(() => pending);
    const status = vi.fn();
    const channel = new RealtimeChannel('topic', rt as unknown as RealtimeModule);
    channel.subscribe();
    await channel.unsubscribe();
    channel.subscribe(status);
    connected();
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith('SUBSCRIBED', undefined));
    expect(rt.joinTopic).toHaveBeenCalledTimes(1);
  });

  it('routes overlapping bindings exactly once by their server id', () => {
    const first = vi.fn(), second = vi.fn();
    const channel = new RealtimeChannel('topic', transport() as unknown as RealtimeModule);
    channel.on('postgres_changes', { event: '*', table: 't', filter: 'id=eq.1' }, first);
    channel.on('postgres_changes', { event: '*', table: 't', filter: 'id=eq.2' }, second);
    const envelope = { topic: 'topic', type: 'postgres_changes' as const, event: 'INSERT', payload: { schema: 'public', table: 't', eventType: 'INSERT', new: { id: 1 }, old: {} } };
    channel._receive({ ...envelope, bindingId: 1 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    channel._receive({ ...envelope, bindingId: 2 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('explicitly refuses multiple bindings on an older server', async () => {
    const rt = transport();
    rt.joinTopic.mockResolvedValue({ status: 'ok', bindingIds: false });
    const status = vi.fn();
    const channel = new RealtimeChannel('topic', rt as unknown as RealtimeModule);
    channel.on('postgres_changes', { event: '*', table: 't' }, () => {});
    channel.on('postgres_changes', { event: 'INSERT', table: 't' }, () => {});
    channel.subscribe(status);
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith('CHANNEL_ERROR', expect.any(Error)));
    expect(rt.leaveTopic).toHaveBeenCalledWith('topic');
  });
});
