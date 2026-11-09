import type { Tone } from '@/shared/ui/Badge';
import type { Access, AccessCommand, AccessRole } from '@/features/database/lib/rls-api';

export const ACCESS_ROLES: AccessRole[] = ['anon', 'authenticated'];
export const ACCESS_COMMANDS: AccessCommand[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

export const COMMAND_LABEL: Record<AccessCommand, string> = {
  SELECT: 'Read',
  INSERT: 'Insert',
  UPDATE: 'Update',
  DELETE: 'Delete',
};

export const ROLE_LABEL: Record<AccessRole, string> = {
  anon: 'Signed out (anon)',
  authenticated: 'Signed in (authenticated)',
};

const VERB: Record<AccessCommand, string> = {
  SELECT: 'read',
  INSERT: 'insert',
  UPDATE: 'update',
  DELETE: 'delete',
};

export interface AccessSummary {
  tone: Extract<Tone, 'success' | 'warn' | 'neutral'>;
  /** Two or three words, fits a matrix cell. */
  label: string;
  /** One sentence saying which gate decided. */
  reason: string;
}

/** The words shown for one cell of the matrix. */
export function describeAccess(
  access: Access,
  role: AccessRole,
  command: AccessCommand,
  rlsEnabled: boolean
): AccessSummary {
  const verb = VERB[command];
  switch (access.level) {
    case 'all':
      return {
        tone: 'success',
        label: 'All rows',
        reason: rlsEnabled
          ? `A policy lets ${role} ${verb} every row.`
          : `RLS is off, so the ${command} grant alone lets ${role} ${verb} every row.`,
      };
    case 'some':
      return {
        tone: 'warn',
        label: 'Some rows',
        reason: `Only rows that pass ${access.conditions.length === 1 ? 'this policy' : 'these policies'}.`,
      };
    case 'none':
      return {
        tone: 'neutral',
        label: 'No',
        reason: {
          grant: `${role} has no ${command} grant on this table, so Postgres refuses the statement.`,
          policy: `RLS is on and no policy lets ${role} ${verb}, so nothing gets through.`,
          read: `A policy allows it, but ${role} cannot read any row to ${verb}.`,
        }[access.blockedBy],
      };
  }
}
