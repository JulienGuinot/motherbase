import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import type {
  AgentMessage,
  PendingCalls,
  Thread,
  ThreadScope,
  ThreadStore,
  ThreadWithMessages,
} from '@motherbase/ai';
import { logActivity } from '../../lib/activity-log';

// Assistant threads live in their own SQLite file next to the console's other
// stores (see console/services/org-store.ts) so they never entangle with the
// auth schema or the project manifests.
export class SqliteThreadStore implements ThreadStore {
  private db: Database.Database;

  /** `file` is an absolute path, or ':memory:' for tests. */
  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_thread (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        userId TEXT NOT NULL,
        title TEXT NOT NULL,
        pending TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ai_thread_scope ON ai_thread(project, userId, updatedAt DESC);
      CREATE TABLE IF NOT EXISTS ai_message (
        id TEXT PRIMARY KEY,
        threadId TEXT NOT NULL REFERENCES ai_thread(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        body TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ai_message_thread ON ai_message(threadId, seq);
    `);
  }

  /** Create a store rooted in a projects directory. */
  static atProjectsDir(dir: string): SqliteThreadStore {
    return new SqliteThreadStore(path.join(dir, 'console-ai.db'));
  }

  close(): void {
    this.db.close();
  }

  async createThread(scope: ThreadScope, title: string): Promise<Thread> {
    const now = new Date().toISOString();
    const row: Thread = {
      id: randomUUID(),
      project: scope.project,
      userId: scope.userId,
      title: title.slice(0, 120) || 'New conversation',
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        'INSERT INTO ai_thread (id, project, userId, title, pending, createdAt, updatedAt) VALUES (?, ?, ?, ?, NULL, ?, ?)',
      )
      .run(row.id, row.project, row.userId, row.title, row.createdAt, row.updatedAt);
    return row;
  }

  async listThreads(scope: ThreadScope): Promise<Thread[]> {
    return this.db
      .prepare(
        'SELECT id, project, userId, title, createdAt, updatedAt FROM ai_thread WHERE project = ? AND userId = ? ORDER BY updatedAt DESC',
      )
      .all(scope.project, scope.userId) as Thread[];
  }

  async getThread(id: string): Promise<ThreadWithMessages | null> {
    const thread = this.db.prepare('SELECT * FROM ai_thread WHERE id = ?').get(id) as
      | (Thread & { pending: string | null })
      | undefined;
    if (!thread) return null;

    const rows = this.db
      .prepare('SELECT body FROM ai_message WHERE threadId = ? ORDER BY seq')
      .all(id) as { body: string }[];

    const { pending, ...rest } = thread;
    return {
      ...rest,
      pending: pending ? (JSON.parse(pending) as PendingCalls) : null,
      messages: rows.map(r => JSON.parse(r.body) as AgentMessage),
    };
  }

  // Sequence numbers are assigned inside a transaction (better-sqlite3 runs
  // synchronously and serializes all statements on the same connection), so
  // two appends against the same thread can never read the same MAX(seq) and
  // collide. That guarantee only holds within a single process; if this store
  // is ever pointed at a shared file from multiple processes, the read-then-
  // insert would need to move into an actual SQLite transaction with
  // IMMEDIATE locking (or the seq column would need to become an
  // AUTOINCREMENT-like construct enforced by a UNIQUE(threadId, seq) index).
  async appendMessage(threadId: string, message: AgentMessage): Promise<void> {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const next = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM ai_message WHERE threadId = ?')
        .get(threadId) as { seq: number };
      this.db
        .prepare('INSERT INTO ai_message (id, threadId, seq, body, createdAt) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), threadId, next.seq, JSON.stringify(message), now);
      this.db.prepare('UPDATE ai_thread SET updatedAt = ? WHERE id = ?').run(now, threadId);
    });
    tx();
  }

  async setPending(threadId: string, pending: PendingCalls | null): Promise<void> {
    this.db
      .prepare('UPDATE ai_thread SET pending = ?, updatedAt = ? WHERE id = ?')
      .run(pending ? JSON.stringify(pending) : null, new Date().toISOString(), threadId);
  }

  async renameThread(id: string, title: string): Promise<void> {
    this.db
      .prepare('UPDATE ai_thread SET title = ?, updatedAt = ? WHERE id = ?')
      .run(title.slice(0, 120), new Date().toISOString(), id);
  }

  async deleteThread(id: string): Promise<void> {
    this.db.prepare('DELETE FROM ai_message WHERE threadId = ?').run(id);
    this.db.prepare('DELETE FROM ai_thread WHERE id = ?').run(id);
  }
}

/**
 * Opens the thread store for a data directory, degrading to an in-memory store
 * when that directory cannot be written.
 *
 * The API container runs with a read-only root filesystem, so an unmounted or
 * misconfigured data directory throws EROFS. That must never stop the server
 * from booting: a failure here costs the operator their conversation history,
 * not their whole project API. The assistant keeps working for the life of the
 * process and the reason is logged once, loudly enough to act on.
 */
export function openThreadStore(
  dataDir: string,
  deps: {
    mkdir?: (dir: string) => void;
    open?: (file: string) => SqliteThreadStore;
    onFallback?: (err: Error) => void;
  } = {},
): SqliteThreadStore {
  const mkdir = deps.mkdir ?? ((dir: string) => void fs.mkdirSync(dir, { recursive: true }));
  const open = deps.open ?? ((file: string) => new SqliteThreadStore(file));
  const onFallback =
    deps.onFallback ??
    // Goes to the ring buffer, not stdout: an operator learns "my conversations
    // vanish on restart" from the Logs screen, not by tailing the container.
    ((err: Error) =>
      logActivity(
        'error',
        'ai',
        `[ai] Assistant threads fall back to memory and will not survive a restart: ${err.message}. ` +
          'Mount a writable volume at the AI_DATA_DIR path (default "data") to persist them.',
      ));

  try {
    mkdir(dataDir);
    return open(path.join(dataDir, 'assistant.db'));
  } catch (err) {
    onFallback(err as Error);
    return open(':memory:');
  }
}
