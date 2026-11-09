import type { PgPolicy } from './rls.service';

/**
 * "Can anon (or a signed-in user) do X to this table?" read off the catalog,
 * with no query to write and no caller to pick.
 *
 * Every rule below mirrors a Postgres behaviour, and the surprising ones were
 * checked against a live server rather than taken from memory:
 *
 *  - The GRANT is the first gate. Without it Postgres raises and no policy can
 *    help.
 *  - With RLS off, the GRANT is the whole answer: every row.
 *  - With RLS on, only PERMISSIVE policies can let rows through. A policy with
 *    no expression at all (`CREATE POLICY p ON t FOR SELECT TO anon;`) lets
 *    nothing through, it does not mean `true`.
 *  - RESTRICTIVE policies only narrow. One with no expression narrows nothing.
 *  - UPDATE and DELETE only ever reach rows the role can also SELECT: Postgres
 *    applies the SELECT policies whenever the statement has a WHERE clause, and
 *    the data API refuses an unfiltered write from anyone but an admin.
 */

export const ACCESS_ROLES = ['anon', 'authenticated'] as const;
export type AccessRole = (typeof ACCESS_ROLES)[number];

export const ACCESS_COMMANDS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
export type AccessCommand = (typeof ACCESS_COMMANDS)[number];

/** A policy that decides which rows get through, with the expressions that apply to this command. */
export interface AccessCondition {
  policy: string;
  command: AccessCommand;
  restrictive: boolean;
  using: string | null;
  withCheck: string | null;
}

export type Access =
  | { level: 'all' }
  | { level: 'some'; conditions: AccessCondition[] }
  /**
   * `grant`: no table privilege, Postgres raises. `policy`: RLS is on and no
   * policy lets a row through, the result is silently empty. `read`: the
   * command itself is allowed, but the rows it would target are invisible.
   */
  | { level: 'none'; blockedBy: 'grant' | 'policy' | 'read' };

export interface TableAccessFacts {
  rlsEnabled: boolean;
  policies: PgPolicy[];
  privileges: Record<AccessRole, AccessCommand[]>;
}

export interface TableAccess {
  table: string;
  rlsEnabled: boolean;
  access: Record<AccessRole, Record<AccessCommand, Access>>;
}

function appliesTo(policy: PgPolicy, role: AccessRole, command: AccessCommand): boolean {
  return (
    (policy.command === command || policy.command === 'ALL') &&
    (policy.roles.includes(role) || policy.roles.some(r => r.toLowerCase() === 'public'))
  );
}

/**
 * The expressions Postgres evaluates for this command. A missing WITH CHECK
 * falls back to USING, which is how an ALL or UPDATE policy with only USING
 * still checks new rows.
 */
function conditionFor(policy: PgPolicy, command: AccessCommand): AccessCondition {
  const check = policy.withCheck ?? policy.using;
  return {
    policy: policy.name,
    command,
    restrictive: !policy.permissive,
    using: command === 'INSERT' ? null : policy.using,
    withCheck: command === 'INSERT' || command === 'UPDATE' ? check : null,
  };
}

function expressions(condition: AccessCondition, command: AccessCommand): Array<string | null> {
  if (command === 'INSERT') return [condition.withCheck];
  if (command === 'UPDATE') return [condition.using, condition.withCheck];
  return [condition.using];
}

const isTrue = (expression: string | null) => expression?.trim().toLowerCase() === 'true';

function commandAccess(facts: TableAccessFacts, role: AccessRole, command: AccessCommand): Access {
  if (!facts.privileges[role].includes(command)) return { level: 'none', blockedBy: 'grant' };
  if (!facts.rlsEnabled) return { level: 'all' };

  const applicable = facts.policies.filter(p => appliesTo(p, role, command)).map(p => conditionFor(p, command));
  const permissive = applicable.filter(
    c => !c.restrictive && expressions(c, command).every(expression => expression !== null)
  );
  if (!permissive.length) return { level: 'none', blockedBy: 'policy' };

  const narrowing = applicable.filter(
    c => c.restrictive && expressions(c, command).some(expression => expression !== null && !isTrue(expression))
  );
  const unconditional = permissive.some(c => expressions(c, command).every(isTrue));
  if (unconditional && !narrowing.length) return { level: 'all' };

  return { level: 'some', conditions: unconditional ? narrowing : [...permissive, ...narrowing] };
}

/** UPDATE and DELETE are bounded by what the role can read, so fold SELECT's answer into theirs. */
function boundedByRead(own: Access, read: Access): Access {
  if (own.level === 'none') return own;
  if (read.level === 'none') return { level: 'none', blockedBy: 'read' };
  if (read.level === 'all') return own;
  return { level: 'some', conditions: [...(own.level === 'some' ? own.conditions : []), ...read.conditions] };
}

export function roleAccess(facts: TableAccessFacts, role: AccessRole): Record<AccessCommand, Access> {
  const read = commandAccess(facts, role, 'SELECT');
  return {
    SELECT: read,
    INSERT: commandAccess(facts, role, 'INSERT'),
    UPDATE: boundedByRead(commandAccess(facts, role, 'UPDATE'), read),
    DELETE: boundedByRead(commandAccess(facts, role, 'DELETE'), read),
  };
}
