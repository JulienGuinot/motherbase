import crypto from 'crypto';
import { z } from 'zod';
import { UserRole, type Prisma } from '@prisma/client';
import BaseContext from '../../context/base-context';
import { maskRow } from '../../constants/admin.constants';
import { HttpException } from '../../exceptions/http-exception';
import { emailRegex } from '../../constants/regex.constants';
import { CREDENTIAL, setCredentialPassword } from '../../auth/credentials';
import { personNameSchema, usernameSchema } from '../../validators/user-fields';
import type { AuditEvent } from '../../auth/audit-actions';
import { SERVICE_ROLE_ACTOR_ID } from './auth-audit.service';

// An impersonation session is short by design: it is a support tool, not a
// second way to be signed in. Nothing extends it. When it expires the operator
// starts a new one, which writes a fresh audit entry.
export const IMPERSONATION_TTL_MINUTES = 15;
export const IMPERSONATION_USER_AGENT = 'motherbase-console (impersonation)';

// Ceiling on one page of the project-wide Sessions list, matching the auth
// audit list next to it. The page is for finding and revoking a session, not
// for exporting the table.
const MAX_SESSIONS_PER_PAGE = 500;

/** What the Studio users table filters on, applied in SQL so it reaches every page. */
export interface UserListFilter {
  /** Substring of the email or username, case-insensitive. */
  search?: string;
  role?: UserRole;
  emailVerified?: boolean;
  anonymous?: boolean;
}

export function userListWhere(filter: UserListFilter): Prisma.UserWhereInput {
  const and: Prisma.UserWhereInput[] = [];
  if (filter.search) {
    const contains = filter.search;
    and.push({ OR: [{ email: { contains, mode: 'insensitive' } }, { username: { contains, mode: 'insensitive' } }] });
  }
  if (filter.role) and.push({ role: filter.role });
  if (filter.emailVerified !== undefined) and.push({ emailVerified: filter.emailVerified });
  // `isAnonymous` is nullable, and a null row is a permanent account. `not: true`
  // would drop those rows, since NULL <> true is not true in SQL.
  if (filter.anonymous !== undefined) {
    and.push(filter.anonymous ? { isAnonymous: true } : { OR: [{ isAnonymous: false }, { isAnonymous: null }] });
  }
  return and.length ? { AND: and } : {};
}

// Columns an admin may write through the generic user PATCH. `role` is
// deliberately absent: promotion has its own audited route.
const UPDATABLE_FIELDS = ['firstName', 'lastName', 'username', 'status'] as const;

// Pre-Better-Auth rows carried the social identity on the user row itself.
// Better Auth never writes these columns (auth/instance.ts declares them
// `input: false`), so they only ever describe accounts created before the
// migration. Kept as a fallback, not as the source of truth.
const LEGACY_PROVIDER_FIELDS: Array<{ field: string; name: string }> = [
  { field: 'appleId', name: 'apple' },
  { field: 'googleId', name: 'google' },
];

/**
 * Which ways this user can sign in.
 *
 * Every identity is an `account` row: social and custom OIDC logins keep their
 * `providerId` ('google', 'github', or whatever `auth.oauth.custom` defines),
 * and a password lives on the reserved 'credential' provider with the hash in
 * `password`. Never `user.googleId` / `user.appleId`: Better Auth does not
 * populate those. Reading the accounts also means a provider never needs
 * registering here: enabling GitHub in settings is enough for it to appear.
 */
const providersFor = (user: Record<string, any>, accounts?: Array<{ providerId: string; password?: string | null }>): string[] => {
  const list = (accounts ?? [])
    .filter(a => a.providerId !== CREDENTIAL)
    .map(a => a.providerId);

  for (const { field, name } of LEGACY_PROVIDER_FIELDS) {
    if (user[field] && !list.includes(name)) list.push(name);
  }

  // 'email' rather than 'credential': it is what the UI labels the row, and the
  // provider ids above are all user-facing names too.
  if (accounts?.some(a => a.providerId === CREDENTIAL && a.password)) list.push('email');

  return [...new Set(list)];
};

/**
 * Accounts as `providersFor` needs them, without reading password hashes: a
 * credential account only counts when it has a password, so the filter keeps
 * that test in the database and the mapper marks the survivors as set.
 */
const PROVIDER_ACCOUNTS = {
  where: { OR: [{ providerId: { not: CREDENTIAL } }, { password: { not: null } }] },
  select: { providerId: true },
};
const withPasswordSet = (accounts: Array<{ providerId: string }>) => accounts.map(a => ({ ...a, password: 'set' }));

/** Sanitised stem for a generated username; suffixes are appended to this. */
export function usernameBase(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || `user${Date.now()}`;
}

/** A Prisma unique-constraint violation on `user.username`, and nothing else. */
export function isUsernameConflict(error: unknown): boolean {
  const e = error as { code?: string; meta?: { target?: unknown } } | null;
  return e?.code === 'P2002' && JSON.stringify(e.meta?.target ?? '').includes('username');
}

export interface MfaFactor {
  id: string;
  factor_type: 'totp' | 'webauthn';
  status: 'verified' | 'unverified';
  friendly_name: string;
  created_at: string | null;
  updated_at: string | null;
}

/** Admin-side user management: listing, detail, and privileged mutations. */
export class UserAdminService extends BaseContext {
  /**
   * An audit row for a change made by an operator or a secret key, in GoTrue's
   * shape for service-role changes: the actor is `service_role`, the user acted
   * on goes in `traits`. Optional-chained like StoragePolicyService: a partial
   * test container has no audit service, and auditing must never fail the change.
   */
  private audit(event: AuditEvent, user: { id: string; email?: string | null }): void {
    this.di.AuthAuditService?.recordInBackground({
      event,
      actorId: SERVICE_ROLE_ACTOR_ID,
      actorUsername: 'service_role',
      traits: { user_id: user.id, user_email: user.email ?? '' },
    });
  }

  async create(input: {
    email?: string;
    username?: string;
    role?: UserRole;
    password?: string;
    sendInvite?: boolean;
    emailVerified?: boolean;
  }): Promise<{ user: any; temporaryPassword: string; invited: boolean }> {
    const email = String(input.email ?? '').trim().toLowerCase();
    if (!email || !emailRegex.test(email)) throw new HttpException('A valid email is required', 400);
    const existing = await this.di.prisma.user.findUnique({ where: { email } });
    if (existing) throw new HttpException('A user with this email already exists', 409);

    const temporaryPassword = input.password?.trim() || crypto.randomBytes(9).toString('base64url');
    if (temporaryPassword.length < 8) throw new HttpException('Password must be at least 8 characters', 400);
    const base = usernameBase(input.username || email.split('@')[0]);
    const now = new Date();
    // Let the unique constraint decide. Checking `findUnique` and then inserting
    // is a race: two concurrent invites both pass the check and the loser sees a
    // 500 instead of getting a second name. Insert, catch P2002, retry salted.
    let user: any = null;
    for (let i = 0; i < 5 && !user; i += 1) {
      const username = i === 0 ? base : `${base}${crypto.randomInt(1000, 9999)}`;
      try {
        user = await this.di.prisma.user.create({
          data: {
            email,
            name: email,
            classicEmail: email,
            username,
            role: input.role === 'ADMIN' ? 'ADMIN' : 'USER',
            emailVerified: input.emailVerified ?? false,
            createdAt: now,
            updatedAt: now,
          },
        });
      } catch (error: any) {
        if (!isUsernameConflict(error)) throw error;
      }
    }
    if (!user) throw new HttpException('Could not allocate a username', 409);
    // Password lives on a Better Auth credential account, not the user row.
    await setCredentialPassword(this.di.prisma, user.id, temporaryPassword);

    let invited = false;
    if (input.sendInvite) {
      await this.di.TransporterService.sendMail({
        to: email,
        subject: 'Your account is ready',
        text: `An account has been created for you. Temporary password: ${temporaryPassword}`,
        html: `<p>An account has been created for you.</p><p>Temporary password: <code>${temporaryPassword}</code></p>`,
      });
      invited = true;
    }
    this.audit(
      invited ? { action: 'user_invited', logType: 'team' } : { action: 'user_signedup', logType: 'team', traits: { provider: 'admin' } },
      user,
    );

    return {
      user: { ...maskRow(user), providers: providersFor(user as any, [{ providerId: 'credential', password: 'set' }]) },
      temporaryPassword,
      invited,
    };
  }

  async list(): Promise<any[]> {
    const users = await this.di.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      include: { accounts: PROVIDER_ACCOUNTS },
    });
    return users.map(u => {
      const { accounts, ...rest } = u as any;
      return { ...maskRow(rest), providers: providersFor(rest, withPasswordSet(accounts)) };
    });
  }

  /**
   * One page of users, for `auth.admin.listUsers()`.
   *
   * Also Studio's users table, which filters here rather than in the browser so
   * a match on page 40 is found. `list()` stays for callers that want every row
   * (the CLI). Same projection, so the two cannot disagree about what a user
   * looks like.
   */
  async listPage(params: { page?: number; perPage?: number; filter?: UserListFilter } = {}): Promise<{
    users: any[];
    page: number;
    perPage: number;
    total: number;
  }> {
    const page = Math.max(1, Math.floor(Number(params.page) || 1));
    // Capped so a caller cannot turn one request into a full table read by
    // asking for a million rows.
    const perPage = Math.min(1000, Math.max(1, Math.floor(Number(params.perPage) || 50)));
    const where = userListWhere(params.filter ?? {});
    const [total, users] = await Promise.all([
      this.di.prisma.user.count({ where }),
      this.di.prisma.user.findMany({
        where,
        // `id` breaks ties, or two users created in the same millisecond could
        // swap between requests and show on two pages or on none.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * perPage,
        take: perPage,
        include: { accounts: PROVIDER_ACCOUNTS },
      }),
    ]);
    return {
      users: users.map(u => {
        const { accounts, ...rest } = u as any;
        return { ...maskRow(rest), providers: providersFor(rest, withPasswordSet(accounts)) };
      }),
      page,
      perPage,
      total,
    };
  }

  async detail(id: string): Promise<any> {
    const user = await this.di.prisma.user.findUnique({
      where: { id },
      include: {
        devices: true,
        sessions: { where: { expiresAt: { gt: new Date() } } },
        accounts: { select: { providerId: true, password: true } },
      },
    });
    if (!user) throw new HttpException('User not found', 404);
    const { sessions, accounts, ...rest } = user as any;
    return {
      ...maskRow(rest),
      providers: providersFor(rest, accounts),
      activeSessions: (sessions ?? []).length,
      sessions: (sessions ?? [])
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .map((s: any) => ({
          id: s.id,
          createdAt: s.createdAt,
          expiresAt: s.expiresAt,
          ipAddress: s.ipAddress ?? null,
          userAgent: s.userAgent ?? null,
          // Non-null ⇒ an operator opened this session, not the user.
          impersonatedBy: s.impersonatedBy ?? null,
        })),
    };
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const { count } = await this.di.prisma.session.deleteMany({ where: { id: sessionId, userId } });
    if (count) this.audit({ action: 'token_revoked', logType: 'token' }, { id: userId });
  }

  /**
   * One page of the active sessions across every user, newest first, for the
   * project-wide Sessions view. Bounded on purpose: an unbounded read grows
   * with the user base, and this is the page an operator needs most when
   * something is wrong.
   *
   * Same `{ page, perPage, total }` shape and the same caps as the auth audit
   * list, which is the page next to it in the console.
   */
  async listSessions(query: { page?: number; perPage?: number } = {}): Promise<{
    sessions: any[];
    page: number;
    perPage: number;
    total: number;
  }> {
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const perPage = Math.min(MAX_SESSIONS_PER_PAGE, Math.max(1, Math.floor(Number(query.perPage) || 50)));
    const where = { expiresAt: { gt: new Date() } };

    const [sessions, total] = await Promise.all([
      this.di.prisma.session.findMany({
        where,
        include: { user: { select: { id: true, email: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: perPage,
        skip: (page - 1) * perPage,
      }),
      this.di.prisma.session.count({ where }),
    ]);

    return {
      page,
      perPage,
      total,
      sessions: sessions.map(s => ({
        id: s.id,
        userId: s.userId,
        userEmail: s.user?.email ?? null,
        userName: s.user?.name ?? null,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        ipAddress: s.ipAddress ?? null,
        userAgent: s.userAgent ?? null,
        impersonatedBy: s.impersonatedBy ?? null,
      })),
    };
  }

  /**
   * Opens a short-lived session as `userId` for an operator. Deliberately NOT
   * Better Auth's admin plugin: `admin.impersonateUser` needs the *caller* to
   * hold a project admin session and hands the result back through cookies,
   * neither of which exists on the server-to-server console path (and mounting
   * that plugin would add `banned`/`banReason`/`banExpires` columns its session
   * hook reads on every sign-in, see the note in auth/instance.ts).
   *
   * Returns a bearer token for the new session. No credential of the
   * impersonated user is read, returned or logged: this mints a new session, it
   * does not recover an existing one.
   */
  async impersonate(userId: string, actorId: string): Promise<{
    token: string;
    sessionId: string;
    expiresAt: Date;
    user: { id: string; email: string; username: string | null };
  }> {
    const user = await this.di.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, username: true, status: true },
    });
    if (!user) throw new HttpException('User not found', 404);
    if (user.status !== 'active') throw new HttpException('Cannot impersonate a non-active user', 400);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + IMPERSONATION_TTL_MINUTES * 60_000);
    const session = await this.di.prisma.session.create({
      data: {
        userId: user.id,
        // Raw, unsigned: the bearer plugin signs it with the auth secret before
        // it is used as a session cookie.
        token: crypto.randomBytes(32).toString('base64url'),
        expiresAt,
        createdAt: now,
        updatedAt: now,
        impersonatedBy: actorId.slice(0, 128),
        userAgent: IMPERSONATION_USER_AGENT,
      },
    });
    return {
      token: session.token,
      sessionId: session.id,
      expiresAt,
      user: { id: user.id, email: user.email, username: user.username },
    };
  }

  /** Ends an impersonation session. Can never delete a real one. */
  async stopImpersonating(token: string): Promise<void> {
    if (!token || typeof token !== 'string') throw new HttpException('A session token is required', 400);
    const { count } = await this.di.prisma.session.deleteMany({
      where: { token, impersonatedBy: { not: null } },
    });
    if (!count) throw new HttpException('No active impersonation session for that token', 404);
  }

  async update(
    id: string,
    data: { firstName?: string; lastName?: string; username?: string; status?: string }
  ): Promise<any> {
    // This is fed straight from req.body, and `data as any` would defeat the
    // signature above: letting a PATCH write `role`, `email` or `emailVerified`
    // and bypass the flows that normally own those columns. Copy an explicit
    // allowlist instead.
    const patch: Record<string, unknown> = {};
    for (const field of UPDATABLE_FIELDS) {
      if (data[field] === undefined) continue;
      // Same limits the project API enforces on the user's own profile: an
      // admin PATCH must not be the way a 500-character username gets in.
      const schema = field === 'username' ? usernameSchema : field === 'status' ? null : personNameSchema;
      if (!schema) {
        patch[field] = data[field];
        continue;
      }
      const parsed = schema.safeParse(data[field]);
      if (!parsed.success) {
        throw new HttpException(`${field}: ${parsed.error.issues[0]?.message ?? 'is not valid'}`, 400);
      }
      patch[field] = parsed.data;
    }
    const user = await this.di.prisma.user.update({ where: { id }, data: patch });
    // Deactivating an account immediately kills its Better Auth sessions.
    if (data.status && data.status !== 'active') {
      await this.di.prisma.session.deleteMany({ where: { userId: id } });
    }
    this.audit({ action: 'user_modified', logType: 'user' }, user);
    return maskRow(user);
  }

  /** Verification is credential-adjacent and must never use the profile PATCH. */
  async setEmailVerified(id: string, value: unknown): Promise<any> {
    const parsed = z.boolean().safeParse(value);
    if (!parsed.success) throw new HttpException('emailVerified must be a boolean', 400);
    const user = await this.di.prisma.user.update({
      where: { id },
      data: { emailVerified: parsed.data },
    });
    return maskRow(user);
  }

  async resetPassword(id: string, newPassword: string): Promise<any> {
    if (!newPassword || newPassword.length < 8)
      throw new HttpException('Password must be at least 8 characters', 400);
    await setCredentialPassword(this.di.prisma, id, newPassword);
    const user = await this.di.prisma.user.findUnique({ where: { id } });
    if (!user) throw new HttpException('User not found', 404);
    this.audit({ action: 'user_updated_password', logType: 'user' }, user);
    return maskRow(user);
  }

  async revokeSessions(id: string): Promise<void> {
    await this.di.prisma.session.deleteMany({ where: { userId: id } });
    this.audit({ action: 'token_revoked', logType: 'token' }, { id });
  }

  async setRole(id: string, role: UserRole): Promise<any> {
    const user = await this.di.prisma.user.update({ where: { id }, data: { role } });
    this.audit({ action: 'user_modified', logType: 'user', traits: { role } }, user);
    return maskRow(user);
  }

  /**
   * The user's MFA factors in the supabase-js `Factor` shape: TOTP from the
   * two-factor plugin (one per user, it is a property of the account there)
   * and each passkey as a `webauthn` factor.
   */
  async listFactors(userId: string): Promise<MfaFactor[]> {
    const user = await this.di.prisma.user.findUnique({
      where: { id: userId },
      include: { twofactors: true, passkeys: true },
    });
    if (!user) throw new HttpException('User not found', 404);
    return [
      ...user.twofactors.map(t => ({
        id: t.id,
        factor_type: 'totp' as const,
        status: t.verified === false ? ('unverified' as const) : ('verified' as const),
        friendly_name: 'TOTP',
        created_at: null,
        updated_at: null,
      })),
      ...user.passkeys.map(p => ({
        id: p.id,
        factor_type: 'webauthn' as const,
        status: 'verified' as const,
        friendly_name: p.name ?? 'Passkey',
        created_at: p.createdAt.toISOString(),
        updated_at: p.createdAt.toISOString(),
      })),
    ];
  }

  /** Remove one factor. Deleting the TOTP factor turns two-factor off for the user. */
  async deleteFactor(userId: string, factorId: string): Promise<{ id: string }> {
    const totp = await this.di.prisma.twoFactor.deleteMany({ where: { id: factorId, userId } });
    if (totp.count) {
      await this.di.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: false } });
    } else {
      const passkey = await this.di.prisma.passkey.deleteMany({ where: { id: factorId, userId } });
      if (!passkey.count) throw new HttpException('Factor not found', 404);
    }
    this.audit({ action: 'factor_deleted', logType: 'factor', traits: { factor_id: factorId } }, { id: userId });
    return { id: factorId };
  }

  async delete(id: string): Promise<void> {
    // Sessions/accounts cascade on user delete (FK onDelete: Cascade).
    const user = await this.di.prisma.user.delete({ where: { id } });
    this.audit({ action: 'user_deleted', logType: 'team' }, user);
  }
}
