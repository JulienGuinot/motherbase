import { EventEmitter } from 'events';
import { logServiceOf, type LogService } from './log-services';

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Structured detail behind a line. The message string stays the human-readable
 * summary; these are the fields an operator filters and sorts on (who called,
 * from where, with what client) and which a formatted sentence cannot answer
 * without being re-parsed. Every field is optional: only the request logger
 * fills them all in.
 */
export interface LogDetails {
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  userId?: string;
}

export interface LogInput extends LogDetails {
  level: LogLevel;
  source: string; // e.g. "http", "sql", "app"
  message: string;
  /** Logs Explorer source. Derived from `source` and `path` when omitted (see log-services). */
  service?: LogService;
}

export interface LogEntry extends LogInput {
  id: number;
  at: string; // ISO timestamp
  service: LogService;
}

/**
 * Fixed-capacity in-memory ring buffer of recent log lines, with an "entry"
 * event so realtime consumers can stream new lines. Single-instance only;
 * a multi-instance deployment would need a shared transport.
 *
 * The buffer is the hot path only. Durable history (anything older than the
 * capacity, or anything at all after a restart) is the job of
 * LogPersistenceService, which subscribes to the same "entry" event.
 */
export class LogBuffer extends EventEmitter {
  private entries: LogEntry[] = [];
  private seq = 0;

  constructor(private capacity = 500) {
    super();
    this.setMaxListeners(0);
  }

  push(input: LogInput): LogEntry {
    const entry: LogEntry = { ...input, service: logServiceOf(input), id: ++this.seq, at: new Date().toISOString() };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    this.emit('entry', entry);
    return entry;
  }

  recent(limit?: number): LogEntry[] {
    if (limit === undefined || limit >= this.entries.length) return [...this.entries];
    return this.entries.slice(this.entries.length - limit);
  }
}
