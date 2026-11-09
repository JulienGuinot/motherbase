import { describe, expect, it, vi } from 'vitest';
import { openThreadStore, SqliteThreadStore } from '../services/admin/ai-thread-store.sqlite';

// The API container runs with read_only: true. Before this, the data directory
// was created at module scope in services/index.ts, so an unmounted volume threw
// EROFS during import and the server never bound its port: every request through
// the console proxy answered 502. Opening the store must degrade, never throw.
describe('openThreadStore', () => {
  it('opens the store under the data directory when it is writable', () => {
    const open = vi.fn((_file: string) => new SqliteThreadStore(':memory:'));
    const mkdir = vi.fn();

    openThreadStore('/app/data', { mkdir, open });

    expect(mkdir).toHaveBeenCalledWith('/app/data');
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toContain('assistant.db');
  });

  it('falls back to memory instead of throwing when the directory is read-only', () => {
    const open = vi.fn((_file: string) => new SqliteThreadStore(':memory:'));
    const onFallback = vi.fn();
    const mkdir = vi.fn(() => {
      throw new Error("EROFS: read-only file system, mkdir '/app/data'");
    });

    const store = openThreadStore('/app/data', { mkdir, open, onFallback });

    expect(store).toBeInstanceOf(SqliteThreadStore);
    expect(open).toHaveBeenCalledWith(':memory:');
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('falls back to memory when the database file itself cannot be opened', () => {
    const onFallback = vi.fn();
    const open = vi.fn((file: string) => {
      if (file !== ':memory:') throw new Error('SQLITE_CANTOPEN: unable to open database file');
      return new SqliteThreadStore(':memory:');
    });

    const store = openThreadStore('/app/data', { mkdir: vi.fn(), open, onFallback });

    expect(store).toBeInstanceOf(SqliteThreadStore);
    expect(open).toHaveBeenLastCalledWith(':memory:');
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('returns a usable store after falling back, so the assistant still works', async () => {
    const store = openThreadStore('/app/data', {
      mkdir: () => {
        throw new Error('EROFS: read-only file system');
      },
      onFallback: () => {},
    });

    const thread = await store.createThread({ project: 'demo', userId: 'u1' }, 'After fallback');
    expect(await store.listThreads({ project: 'demo', userId: 'u1' })).toHaveLength(1);
    expect((await store.getThread(thread.id))?.title).toBe('After fallback');
  });
});
