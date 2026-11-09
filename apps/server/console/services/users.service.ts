import type { AuthInstance } from '../auth/instance';
import { hashPassword, verifyPassword as verifyHash } from '../auth/password';
import { coerceRole, type UserRole } from '../auth/session';

export type { UserRole } from '../auth/session';

// Multi-user store for the Platform Console, backed by Better Auth (SQLite).
// This class preserves the method surface the console routes/middlewares depend
// on (list/findByEmail/findById/create/update/setPassword/delete/ownerCount +
// projectsOf + seed) while delegating persistence to Better Auth's low-level
// context adapters. It intentionally bypasses the HTTP/authorization layer:
// this is a trusted server-side admin service, and using the internal adapter
// avoids the chicken-and-egg of needing an admin session to seed the first
// owner.
//
// Mapping to Better Auth:
//   role     -> user.role     (additional field)
//   disabled -> user.disabled (additional field)
//   projects -> organization memberships (one org per project; org.name holds
//               the canonical project id, org.slug a sanitized unique key)
//   password -> a `credential` account holding a bcrypt hash (see auth/password)

export interface User {
  id: string;
  email: string;
  role: UserRole;
  projects: string[];
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

// Kept for import compatibility: password never lives on this object anymore.
export type PublicUser = User;
export function toPublicUser(u: User): PublicUser {
  return u;
}

const CREDENTIAL = 'credential';

interface CreateInput {
  email: string;
  password: string;
  role: UserRole;
  projects?: string[];
  passwordTemporary?: boolean;
}

interface UpdatePatch {
  role?: UserRole;
  projects?: string[];
  disabled?: boolean;
  password?: string;
  passwordTemporary?: boolean;
}

type Ctx = Awaited<AuthInstance['$context']>;
type MembershipAdapter = Pick<Ctx['adapter'], 'findMany' | 'create' | 'deleteMany'>;

interface MembershipRow {
  userId: string;
  organizationId: string;
}

interface OrganizationRow {
  id: string;
  name: string;
}

interface SqliteRunResult {
  changes: number;
}

interface ConsoleAuthDatabase {
  prepare(sql: string): {
    run(...params: unknown[]): SqliteRunResult;
  };
  transaction<T>(operation: () => T): () => T;
}

export class PlatformUsersService {
  private ctxPromise: Promise<Ctx> | null = null;

  constructor(private auth: AuthInstance) {}

  private ctx(): Promise<Ctx> {
    if (!this.ctxPromise) this.ctxPromise = this.auth.$context as Promise<Ctx>;
    return this.ctxPromise;
  }

  /** Sanitized, reversibly-keyed slug for a project's backing organization. */
  private orgSlug(projectId: string): string {
    return `p-${projectId.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`.slice(0, 60);
  }

  private toUser(row: any, projects: string[]): User {
    const created = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt ?? Date.now());
    return {
      id: String(row.id),
      email: String(row.email),
      role: coerceRole(row.role),
      projects,
      disabled: Boolean(row.disabled),
      mustChangePassword: Boolean(row.mustChangePassword),
      createdAt: created.toISOString(),
    };
  }

  private async projectsByUser(adapter: MembershipAdapter, userIds?: readonly string[]): Promise<Map<string, string[]>> {
    const projects = new Map<string, string[]>();
    for (const userId of userIds ?? []) projects.set(userId, []);
    if (userIds?.length === 0) return projects;

    const members = await adapter.findMany<MembershipRow>({
      model: 'member',
      where: userIds ? [{ field: 'userId', operator: 'in', value: [...userIds] }] : undefined,
    });
    const organizationIds = [...new Set(members.map(member => member.organizationId))];
    if (organizationIds.length === 0) return projects;

    const organizations = await adapter.findMany<OrganizationRow>({
      model: 'organization',
      where: [{ field: 'id', operator: 'in', value: organizationIds }],
    });
    const namesById = new Map(organizations.map(organization => [organization.id, organization.name]));
    for (const member of members) {
      const name = namesById.get(member.organizationId);
      if (name) projects.set(member.userId, [...(projects.get(member.userId) ?? []), name]);
    }
    return projects;
  }

  async projectsOf(userId: string): Promise<string[]> {
    const ctx = await this.ctx();
    return (await this.projectsByUser(ctx.adapter, [userId])).get(userId) ?? [];
  }

  private async setProjects(userId: string, desired: string[]): Promise<void> {
    const ctx = await this.ctx();
    const desiredProjects = [...new Set(desired)];

    await ctx.adapter.transaction(async adapter => {
      const current = new Set((await this.projectsByUser(adapter, [userId])).get(userId) ?? []);
      const toAdd = desiredProjects.filter(projectId => !current.has(projectId));
      const toRemove = [...current].filter(projectId => !desiredProjects.includes(projectId));
      const touched = [...toAdd, ...toRemove];
      if (touched.length === 0) return;

      const organizations = await adapter.findMany<OrganizationRow>({
        model: 'organization',
        where: [{ field: 'name', operator: 'in', value: touched }],
      });
      const organizationsByName = new Map(organizations.map(organization => [organization.name, organization]));

      for (const projectId of toAdd) {
        if (organizationsByName.has(projectId)) continue;
        const organization = await adapter.create<Record<string, unknown>, OrganizationRow>({
          model: 'organization',
          data: { name: projectId, slug: this.orgSlug(projectId), createdAt: new Date(), updatedAt: new Date() },
        });
        organizationsByName.set(projectId, organization);
      }

      const removedOrganizationIds = toRemove
        .map(projectId => organizationsByName.get(projectId)?.id)
        .filter((id): id is string => Boolean(id));
      if (removedOrganizationIds.length > 0) {
        await adapter.deleteMany({
          model: 'member',
          where: [
            { field: 'userId', value: userId },
            { field: 'organizationId', operator: 'in', value: removedOrganizationIds },
          ],
        });
      }

      await Promise.all(toAdd.map(projectId => adapter.create({
        model: 'member',
        data: {
          organizationId: organizationsByName.get(projectId)!.id,
          userId,
          role: 'member',
          createdAt: new Date(),
        },
      })));
    });
  }

  async list(): Promise<User[]> {
    const ctx = await this.ctx();
    const rows = await ctx.internalAdapter.listUsers();
    const userIds = rows.map(row => String((row as any).id));
    const projects = await this.projectsByUser(ctx.adapter, userIds);
    return rows.map((row, index) => this.toUser(row, projects.get(userIds[index]) ?? []));
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const ctx = await this.ctx();
    const found = await ctx.internalAdapter.findUserByEmail(String(email ?? ''));
    if (!found?.user) return undefined;
    return this.toUser(found.user, await this.projectsOf(String(found.user.id)));
  }

  async findById(id: string): Promise<User | undefined> {
    const ctx = await this.ctx();
    const user = await ctx.internalAdapter.findUserById(id);
    if (!user) return undefined;
    return this.toUser(user, await this.projectsOf(id));
  }

  async create(input: CreateInput): Promise<User> {
    const email = String(input.email ?? '').trim();
    if (!email) throw new Error('email is required');
    if (!input.password) throw new Error('password is required');
    if (await this.findByEmail(email)) throw new Error('email already exists');
    return this.provision({
      email,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      projects: input.projects ?? [],
      mustChangePassword: input.passwordTemporary ?? false,
    });
  }

  /**
   * Low-level provision from an already-hashed password. Shared by `create`
   * (which hashes first) and the seed/migration paths (which carry an existing
   * bcrypt hash and must NOT re-hash).
   */
  async provision(input: {
    email: string;
    passwordHash: string;
    role: UserRole;
    projects?: string[];
    disabled?: boolean;
    mustChangePassword?: boolean;
  }): Promise<User> {
    const ctx = await this.ctx();
    const user = await ctx.internalAdapter.createUser({
      email: input.email,
      name: input.email,
      emailVerified: true,
      role: input.role,
      disabled: input.disabled ?? false,
      mustChangePassword: input.mustChangePassword ?? false,
    } as any, { method: 'admin' });
    await ctx.internalAdapter.linkAccount({
      userId: String(user.id),
      providerId: CREDENTIAL,
      accountId: String(user.id),
      password: input.passwordHash,
    } as any);
    await this.setProjects(String(user.id), input.projects ?? []);
    return this.toUser(user, input.projects ?? []);
  }

  private async updatePassword(id: string, password: string, temporary: boolean): Promise<void> {
    const ctx = await this.ctx();
    const hash = await hashPassword(password);
    // The Console auth instance is deliberately backed by better-sqlite3. Use its
    // native transaction here: Better Auth's generic adapter may degrade to
    // sequential operations, which could change the hash without changing the
    // rotation flag after a partial failure.
    const database = ctx.options.database as unknown as ConsoleAuthDatabase;
    if (!database?.prepare || !database.transaction) {
      throw new Error('Console auth database does not support atomic password changes');
    }
    database.transaction(() => {
      const now = Date.now();
      const credential = database.prepare(`
        UPDATE account SET password = ?, updatedAt = ?
        WHERE userId = ? AND providerId = ?
      `).run(hash, now, id, CREDENTIAL);
      if (credential.changes !== 1) throw new Error('Credential account not found');

      const user = database.prepare(`
        UPDATE user SET mustChangePassword = ?, updatedAt = ? WHERE id = ?
      `).run(temporary ? 1 : 0, now, id);
      if (user.changes !== 1) throw new Error('Console user not found');
    })();
  }

  async update(id: string, patch: UpdatePatch): Promise<User | undefined> {
    const ctx = await this.ctx();
    const existing = await ctx.internalAdapter.findUserById(id);
    if (!existing) return undefined;

    const data: Record<string, any> = {};
    if (patch.role !== undefined) data.role = patch.role;
    if (patch.disabled !== undefined) data.disabled = patch.disabled;
    if (Object.keys(data).length) await ctx.internalAdapter.updateUser(id, data);

    if (typeof patch.password === 'string' && patch.password !== '') {
      const temporary = patch.passwordTemporary ?? true;
      await this.updatePassword(id, patch.password, temporary);
      if (temporary) await ctx.internalAdapter.deleteUserSessions(id);
    }

    if (patch.projects !== undefined) await this.setProjects(id, patch.projects);

    return this.findById(id);
  }

  async setPassword(id: string, newPassword: string): Promise<User | undefined> {
    return this.update(id, { password: newPassword, passwordTemporary: false });
  }

  async revokeSessions(id: string): Promise<boolean> {
    const ctx = await this.ctx();
    if (!(await ctx.internalAdapter.findUserById(id))) return false;
    await ctx.internalAdapter.deleteUserSessions(id);
    return true;
  }

  /** Verify a plaintext password against the user's stored credential hash. */
  async verifyPassword(id: string, password: string): Promise<boolean> {
    const ctx = await this.ctx();
    const account = (await ctx.internalAdapter.findAccounts(id)).find(a => a.providerId === CREDENTIAL);
    if (!account?.password) return false;
    return verifyHash({ password, hash: account.password });
  }

  async delete(id: string): Promise<boolean> {
    const ctx = await this.ctx();
    const existing = await ctx.internalAdapter.findUserById(id);
    if (!existing) return false;
    await ctx.adapter.deleteMany({ model: 'member', where: [{ field: 'userId', value: id }] });
    await ctx.internalAdapter.deleteUserSessions(id);
    await ctx.internalAdapter.deleteAccounts(id);
    await ctx.internalAdapter.deleteUser(id);
    return true;
  }

  /** Number of owners: used to guard against removing the last owner. */
  async ownerCount(): Promise<number> {
    const ctx = await this.ctx();
    return ctx.adapter.count({ model: 'user', where: [{ field: 'role', value: 'owner' }] });
  }

  /** Seed a single `owner` from a plaintext password if the store is empty. */
  async seedOwner(seed: { email: string; password: string; passwordTemporary?: boolean }): Promise<User | undefined> {
    if ((await this.list()).length > 0) return undefined;
    if (!seed.email || !seed.password) return undefined;
    return this.create({
      email: seed.email,
      password: seed.password,
      role: 'owner',
      passwordTemporary: seed.passwordTemporary ?? false,
    });
  }

  /**
   * Seed a single `owner` from an existing bcrypt hash (the env admin supplies a
   * hash, not a plaintext) if the store is empty. Idempotent by emptiness.
   */
  async seedOwnerWithHash(seed: {
    email?: string;
    passwordHash?: string;
    passwordTemporary?: boolean;
  }): Promise<User | undefined> {
    if (!seed.email || !seed.passwordHash) return undefined;
    if ((await this.list()).length > 0) return undefined;
    return this.provision({
      email: seed.email,
      passwordHash: seed.passwordHash,
      role: 'owner',
      mustChangePassword: seed.passwordTemporary ?? false,
    });
  }
}
