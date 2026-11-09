import path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

// Tenant layer that sits ABOVE projects (Supabase-style: organization → projects).
// Deliberately separate from the Better Auth `organization` model, which the
// console already uses as the per-project access ACL (org.name = project id). This
// store owns three concerns the ACL doesn't: real tenant orgs, who belongs to them,
// and which project belongs to which org. Backed by its own SQLite file so it never
// entangles with the auth schema or the filesystem project manifests.

export type OrgRole = 'owner' | 'admin' | 'member';
const ROLES: OrgRole[] = ['owner', 'admin', 'member'];

export interface Org {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface OrgWithMeta extends Org {
  role: OrgRole;
  projectCount: number;
}

export interface OrgMember {
  userId: string;
  role: OrgRole;
  createdAt: string;
}

/**
 * An organization's AI assistant credentials, shared by every project it owns.
 *
 * `apiKey` is a sealed token (see helpers/secret-box), never the key itself:
 * this store never learns how to read it, and a row read by mistake leaks
 * nothing. The service that owns the key does the sealing.
 */
export interface OrgAiConfigRow {
  enabled: boolean;
  provider: string;
  model: string;
  /** Sealed. Empty when the org has no key of its own. */
  apiKey: string;
  baseUrl: string;
  updatedAt: string;
}

function coerceRole(role: unknown): OrgRole {
  return ROLES.includes(role as OrgRole) ? (role as OrgRole) : 'member';
}

/** Lowercase, hyphenated, alnum-only slug base (unique suffixing happens in create). */
export function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return base || 'org';
}

export class OrgStore {
  private db: Database.Database;

  /** `file` is an absolute path, or ':memory:' for tests. */
  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  /** Create a store rooted in a projects directory. */
  static open(projectsDir: string): OrgStore {
    return new OrgStore(path.join(projectsDir, 'console-orgs.db'));
  }

  /** Idempotent schema creation: safe to run at every boot. */
  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS organization (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS org_member (
        orgId TEXT NOT NULL,
        userId TEXT NOT NULL,
        role TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (orgId, userId)
      );
      CREATE TABLE IF NOT EXISTS project_org (
        project TEXT PRIMARY KEY,
        orgId TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS org_ai_config (
        orgId TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        apiKey TEXT NOT NULL DEFAULT '',
        baseUrl TEXT NOT NULL DEFAULT '',
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_org_member_user ON org_member(userId);
      CREATE INDEX IF NOT EXISTS idx_project_org_org ON project_org(orgId);
    `);
  }

  close(): void {
    this.db.close();
  }

  // ── Orgs ──────────────────────────────────────────────────────────────────

  private uniqueSlug(name: string): string {
    const base = slugify(name);
    let slug = base;
    let n = 2;
    const exists = this.db.prepare('SELECT 1 FROM organization WHERE slug = ?');
    while (exists.get(slug)) slug = `${base}-${n++}`;
    return slug;
  }

  /** Create an org and make `ownerUserId` its owner in one transaction. */
  createOrg(name: string, ownerUserId: string): Org {
    const org: Org = {
      id: randomUUID(),
      name: name.trim() || 'Organization',
      slug: this.uniqueSlug(name),
      createdAt: new Date().toISOString(),
    };
    const tx = this.db.transaction(() => {
      this.db.prepare('INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)')
        .run(org.id, org.name, org.slug, org.createdAt);
      this.db.prepare('INSERT INTO org_member (orgId, userId, role, createdAt) VALUES (?, ?, ?, ?)')
        .run(org.id, ownerUserId, 'owner', org.createdAt);
    });
    tx();
    return org;
  }

  getOrg(id: string): Org | undefined {
    return this.db.prepare('SELECT id, name, slug, createdAt FROM organization WHERE id = ?').get(id) as Org | undefined;
  }

  renameOrg(id: string, name: string): Org | undefined {
    const org = this.getOrg(id);
    if (!org) return undefined;
    const clean = name.trim();
    if (!clean) return org;
    this.db.prepare('UPDATE organization SET name = ? WHERE id = ?').run(clean, id);
    return { ...org, name: clean };
  }

  /** Delete an org. Refuses while it still owns projects (caller reassigns first). */
  deleteOrg(id: string): { ok: boolean; reason?: string } {
    if (!this.getOrg(id)) return { ok: false, reason: 'not found' };
    const projects = this.projectsOfOrg(id);
    if (projects.length) return { ok: false, reason: 'organization still has projects' };
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM org_member WHERE orgId = ?').run(id);
      this.db.prepare('DELETE FROM organization WHERE id = ?').run(id);
    });
    tx();
    return { ok: true };
  }

  /** Orgs a user belongs to, annotated with their role and project count. */
  listForUser(userId: string): OrgWithMeta[] {
    const rows = this.db.prepare(`
      SELECT o.id, o.name, o.slug, o.createdAt, m.role,
             (SELECT COUNT(*) FROM project_org p WHERE p.orgId = o.id) AS projectCount
      FROM organization o
      JOIN org_member m ON m.orgId = o.id
      WHERE m.userId = ?
      ORDER BY o.createdAt ASC
    `).all(userId) as any[];
    return rows.map(r => ({ ...r, role: coerceRole(r.role), projectCount: Number(r.projectCount) }));
  }

  listAllOrgs(): Org[] {
    return this.db.prepare('SELECT id, name, slug, createdAt FROM organization ORDER BY createdAt ASC').all() as Org[];
  }

  // ── Membership ──────────────────────────────────────────────────────────────

  isMember(orgId: string, userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM org_member WHERE orgId = ? AND userId = ?').get(orgId, userId);
  }

  memberRole(orgId: string, userId: string): OrgRole | undefined {
    const row = this.db.prepare('SELECT role FROM org_member WHERE orgId = ? AND userId = ?').get(orgId, userId) as { role?: string } | undefined;
    return row ? coerceRole(row.role) : undefined;
  }

  listMembers(orgId: string): OrgMember[] {
    return (this.db.prepare('SELECT userId, role, createdAt FROM org_member WHERE orgId = ? ORDER BY createdAt ASC').all(orgId) as any[])
      .map(r => ({ userId: String(r.userId), role: coerceRole(r.role), createdAt: String(r.createdAt) }));
  }

  addMember(orgId: string, userId: string, role: OrgRole = 'member'): void {
    this.db.prepare(`
      INSERT INTO org_member (orgId, userId, role, createdAt) VALUES (?, ?, ?, ?)
      ON CONFLICT(orgId, userId) DO UPDATE SET role = excluded.role
    `).run(orgId, userId, coerceRole(role), new Date().toISOString());
  }

  /** Whether this member is the org's only owner: removing or demoting them would orphan it. */
  isLastOwner(orgId: string, userId: string): boolean {
    if (this.memberRole(orgId, userId) !== 'owner') return false;
    const owners = this.db.prepare("SELECT COUNT(*) AS c FROM org_member WHERE orgId = ? AND role = 'owner'").get(orgId) as { c: number };
    return Number(owners.c) <= 1;
  }

  /** Remove a member. Refuses to remove the last owner (would orphan the org). */
  removeMember(orgId: string, userId: string): { ok: boolean; reason?: string } {
    const role = this.memberRole(orgId, userId);
    if (!role) return { ok: false, reason: 'not a member' };
    if (this.isLastOwner(orgId, userId)) return { ok: false, reason: 'cannot remove the last owner' };
    this.db.prepare('DELETE FROM org_member WHERE orgId = ? AND userId = ?').run(orgId, userId);
    return { ok: true };
  }

  // ── Project ↔ org ───────────────────────────────────────────────────────────

  assignProject(project: string, orgId: string): void {
    this.db.prepare(`
      INSERT INTO project_org (project, orgId) VALUES (?, ?)
      ON CONFLICT(project) DO UPDATE SET orgId = excluded.orgId
    `).run(project, orgId);
  }

  unassignProject(project: string): void {
    this.db.prepare('DELETE FROM project_org WHERE project = ?').run(project);
  }

  orgOfProject(project: string): string | undefined {
    const row = this.db.prepare('SELECT orgId FROM project_org WHERE project = ?').get(project) as { orgId?: string } | undefined;
    return row?.orgId;
  }

  projectsOfOrg(orgId: string): string[] {
    return (this.db.prepare('SELECT project FROM project_org WHERE orgId = ?').all(orgId) as { project: string }[]).map(r => r.project);
  }

  // ── AI assistant ────────────────────────────────────────────────────────────

  /** The org's stored AI config, with the key still sealed. */
  getAiConfig(orgId: string): OrgAiConfigRow | undefined {
    const row = this.db
      .prepare('SELECT enabled, provider, model, apiKey, baseUrl, updatedAt FROM org_ai_config WHERE orgId = ?')
      .get(orgId) as (Omit<OrgAiConfigRow, 'enabled'> & { enabled: number }) | undefined;
    return row ? { ...row, enabled: Boolean(row.enabled) } : undefined;
  }

  /** Replace the org's AI config. `apiKey` must already be sealed. */
  setAiConfig(orgId: string, config: Omit<OrgAiConfigRow, 'updatedAt'>): OrgAiConfigRow {
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO org_ai_config (orgId, enabled, provider, model, apiKey, baseUrl, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(orgId) DO UPDATE SET
          enabled = excluded.enabled,
          provider = excluded.provider,
          model = excluded.model,
          apiKey = excluded.apiKey,
          baseUrl = excluded.baseUrl,
          updatedAt = excluded.updatedAt
      `)
      .run(orgId, config.enabled ? 1 : 0, config.provider, config.model, config.apiKey, config.baseUrl, updatedAt);
    return { ...config, updatedAt };
  }

  clearAiConfig(orgId: string): void {
    this.db.prepare('DELETE FROM org_ai_config WHERE orgId = ?').run(orgId);
  }

  // ── Backfill ─────────────────────────────────────────────────────────────────

  /** The default org, created on first backfill. */
  ensureDefaultOrg(ownerUserId?: string): Org {
    const existing = this.db.prepare("SELECT id, name, slug, createdAt FROM organization WHERE slug = 'default-organization'").get() as Org | undefined;
    if (existing) return existing;
    const org: Org = {
      id: randomUUID(),
      name: 'Default Organization',
      slug: 'default-organization',
      createdAt: new Date().toISOString(),
    };
    this.db.prepare('INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)')
      .run(org.id, org.name, org.slug, org.createdAt);
    if (ownerUserId) this.addMember(org.id, ownerUserId, 'owner');
    return org;
  }

  /**
   * Idempotent migration for existing single-tenant installs: guarantee a default
   * org, make every console user a member of it (global owners → org owner), and
   * assign every not-yet-assigned project to it. Never downgrades an existing role
   * or moves an already-assigned project.
   */
  backfill(input: { users: { id: string; role: string }[]; projectNames: string[] }): Org {
    const def = this.ensureDefaultOrg();
    const tx = this.db.transaction(() => {
      for (const u of input.users) {
        if (!this.isMember(def.id, u.id)) {
          this.addMember(def.id, u.id, u.role === 'owner' ? 'owner' : 'member');
        }
      }
      for (const name of input.projectNames) {
        if (!this.orgOfProject(name)) this.assignProject(name, def.id);
      }
    });
    tx();
    return def;
  }
}
