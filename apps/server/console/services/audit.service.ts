import path from 'path';
import { randomUUID } from 'crypto';
import { chmodSync, existsSync } from 'fs';
import { isIP } from 'net';
import Database from 'better-sqlite3';
import type { UserRole } from '../auth/session';

const DEFAULT_AUDIT_RETENTION = 10_000;
const MAX_AUDIT_RETENTION = 1_000_000;
const DEFAULT_AUDIT_LIMIT = 100;
const MAX_AUDIT_LIMIT = 500;

type AuditDetailValue = string | number | boolean | null | string[];
export type AuditDetail = Record<string, AuditDetailValue>;
type AuditActorRole = UserRole | 'unknown';

export interface AuditEvent {
  id: string;
  at: string;
  actorId: string;
  actorEmail: string;
  actorRole: AuditActorRole;
  ip: string;
  action: string;
  target: string;
  success: boolean;
  detail: AuditDetail;
}

export type AuditEventInput = Omit<AuditEvent, 'id' | 'at' | 'detail'> & {
  detail?: Record<string, unknown>;
};

interface AuditStoreOptions {
  maxEntries?: number;
  now?: () => Date;
  idFactory?: () => string;
}

interface AuditRow extends Omit<AuditEvent, 'success' | 'detail'> {
  success: number;
  detail: string;
}

const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|secret|token|api.?key|private.?key|credential|payload|body)/i;
const SENSITIVE_VALUE = /^(?:bearer\s+)?[a-z0-9_-]{16,}\.[a-z0-9_-]{8,}(?:\.[a-z0-9_-]{8,})?$/i;

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

/**
 * Defense in depth for structured metadata. Audit callers must only submit
 * allow-listed fields; this also drops accidental credentials before SQLite.
 */
export function sanitizeAuditDetail(input: Record<string, unknown> | undefined): AuditDetail {
  const output: AuditDetail = {};
  for (const [key, value] of Object.entries(input ?? {}).slice(0, 50)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (typeof value === 'string') {
      if (SENSITIVE_VALUE.test(value) || value.startsWith('$2')) continue;
      output[key] = value.slice(0, 256);
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) output[key] = value;
    else if (typeof value === 'boolean' || value === null) output[key] = value;
    else if (Array.isArray(value)) {
      output[key] = value
        .filter((item): item is string => typeof item === 'string')
        .filter(item => !SENSITIVE_VALUE.test(item) && !item.startsWith('$2'))
        .slice(0, 50)
        .map(item => item.slice(0, 128));
    }
  }
  return output;
}

function auditText(value: string, maxLength: number, fallback: string): string {
  const normalized = value.replace(/[\r\n\0]/g, ' ').trim().slice(0, maxLength);
  if (!normalized || SENSITIVE_VALUE.test(normalized) || normalized.startsWith('$2')) return fallback;
  return normalized;
}

export function normalizeAuditIp(value: unknown): string {
  const candidate = typeof value === 'string' ? value.trim() : '';
  const mappedIpv4 = candidate.toLowerCase().startsWith('::ffff:') ? candidate.slice(7) : '';
  if (mappedIpv4 && isIP(mappedIpv4) === 4) return mappedIpv4;
  return isIP(candidate) ? candidate.toLowerCase() : 'unknown';
}

/** Persistent operator audit log, intentionally isolated from Better Auth. */
export class AuditStore {
  private readonly db: Database.Database;
  private readonly file: string;
  private readonly maxEntries: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  /** `file` is an absolute path, or ':memory:' for tests. */
  constructor(file: string, options: AuditStoreOptions = {}) {
    this.file = file;
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.maxEntries = boundedInteger(options.maxEntries, DEFAULT_AUDIT_RETENTION, 1, MAX_AUDIT_RETENTION);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.init();
    this.restrictFilePermissions();
  }

  static open(projectsDir: string, options: AuditStoreOptions = {}): AuditStore {
    return new AuditStore(path.join(projectsDir, 'console-audit.db'), options);
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_event (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL,
        actorId TEXT NOT NULL,
        actorEmail TEXT NOT NULL,
        actorRole TEXT NOT NULL,
        ip TEXT NOT NULL DEFAULT 'unknown',
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        success INTEGER NOT NULL CHECK (success IN (0, 1)),
        detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_event_at ON audit_event(at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_event_actor ON audit_event(actorId, seq DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_event_action ON audit_event(action, seq DESC);
    `);
    const columns = this.db.prepare('PRAGMA table_info(audit_event)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'ip')) {
      this.db.exec("ALTER TABLE audit_event ADD COLUMN ip TEXT NOT NULL DEFAULT 'unknown'");
    }
  }

  append(input: AuditEventInput): AuditEvent {
    const event: AuditEvent = {
      id: this.idFactory(),
      at: this.now().toISOString(),
      actorId: auditText(input.actorId, 128, 'unknown'),
      actorEmail: auditText(input.actorEmail, 254, 'unknown'),
      actorRole: input.actorRole,
      ip: normalizeAuditIp(input.ip),
      action: auditText(input.action, 128, 'unknown'),
      target: auditText(input.target, 256, 'unknown'),
      success: Boolean(input.success),
      detail: sanitizeAuditDetail(input.detail),
    };
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO audit_event
          (id, at, actorId, actorEmail, actorRole, ip, action, target, success, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.at,
        event.actorId,
        event.actorEmail,
        event.actorRole,
        event.ip,
        event.action,
        event.target,
        event.success ? 1 : 0,
        JSON.stringify(event.detail),
      );
      this.db.prepare(`
        DELETE FROM audit_event
        WHERE seq IN (
          SELECT seq FROM audit_event ORDER BY seq DESC LIMIT -1 OFFSET ?
        )
      `).run(this.maxEntries);
    });
    transaction();
    this.restrictFilePermissions();
    return event;
  }

  private restrictFilePermissions(): void {
    if (this.file === ':memory:' || process.platform === 'win32') return;
    // WAL and SHM contain the same sensitive records as the primary database.
    for (const file of [this.file, `${this.file}-wal`, `${this.file}-shm`]) {
      if (existsSync(file)) chmodSync(file, 0o600);
    }
  }

  list(limit = DEFAULT_AUDIT_LIMIT): AuditEvent[] {
    const safeLimit = boundedInteger(limit, DEFAULT_AUDIT_LIMIT, 1, MAX_AUDIT_LIMIT);
    const rows = this.db.prepare(`
      SELECT id, at, actorId, actorEmail, actorRole, ip, action, target, success, detail
      FROM audit_event
      ORDER BY seq DESC
      LIMIT ?
    `).all(safeLimit) as AuditRow[];
    return rows.map(row => ({
      ...row,
      actorRole: row.actorRole as AuditActorRole,
      success: row.success === 1,
      detail: parseDetail(row.detail),
    }));
  }

  close(): void {
    this.db.close();
  }
}

function parseDetail(raw: string): AuditDetail {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function parseAuditLimit(value: unknown): number | undefined {
  if (value === undefined) return DEFAULT_AUDIT_LIMIT;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_AUDIT_LIMIT ? parsed : undefined;
}
