import { HTTP_ROUTES } from '@motherbase/contracts';
import { User } from '../auth/types.js';

/**
 * `client.auth.admin`, shaped like `supabase.auth.admin`.
 *
 * Every method here needs a **secret** project API key, so the client it hangs
 * off must have been built with one. A publishable key gets a 401 from the
 * server, which is the correct outcome: these calls create and delete users
 * without being any user.
 *
 * Two differences from supabase-js worth knowing before you port code:
 *
 *   * Scope. This is user administration only. Supabase's service key also opens
 *     SQL and DDL; here those stay behind operator authentication, so a leaked
 *     application key cannot drop a table.
 *   * `generateLink` covers signup, invite, magiclink and recovery. Recovery is
 *     code-based here, so it returns `email_otp` and no `action_link`, and the
 *     `email_change_*` types are refused.
 */

export interface AdminListUsersParams {
    page?: number;
    perPage?: number;
}

export interface AdminUserList {
    users: User[];
    page: number;
    perPage: number;
    total: number;
}

export interface AdminCreateUserParams {
    email: string;
    password?: string;
    username?: string;
    role?: 'ADMIN' | 'USER';
    /** Mark the address verified without sending a confirmation. */
    email_confirm?: boolean;
    /** Also email the temporary password. `invite()` is the same thing, named. */
    sendInvite?: boolean;
}

export interface AdminCreatedUser {
    user: User;
    /** Generated when no password was supplied. Never logged by the SDK. */
    temporaryPassword: string;
    invited: boolean;
}

export interface AdminUpdateUserParams {
    password?: string;
    role?: 'ADMIN' | 'USER';
    username?: string;
    firstName?: string;
    lastName?: string;
    status?: string;
}

export interface AdminGenerateLinkParams {
    type: 'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change_current' | 'email_change_new';
    email: string;
    /** Required for `signup`. */
    password?: string;
    newEmail?: string;
    options?: { redirectTo?: string; data?: Record<string, unknown> };
}

export interface AdminGeneratedLink {
    properties: {
        /** The link the email would carry. Null for `recovery`, which is code-based here. */
        action_link: string | null;
        email_otp: string | null;
        hashed_token: string | null;
        redirect_to: string | null;
        verification_type: string;
    };
    user: User | null;
}

/** A supabase-js `Factor`: TOTP from two-factor, and each passkey as `webauthn`. */
export interface AdminMfaFactor {
    id: string;
    factor_type: 'totp' | 'webauthn';
    status: 'verified' | 'unverified';
    friendly_name: string;
    created_at: string | null;
    updated_at: string | null;
}

export const BASE = HTTP_ROUTES.authAdmin;


