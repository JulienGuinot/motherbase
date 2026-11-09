import { HttpClient } from "../http/index.js";
import { settle } from "../http/utils.js";
import { MotherbaseResponse } from "../types.js";
import { User } from "../auth/types.js";
import { AuthAdminMfaClient } from "./auth-admin-mfa-client.js";
import { AdminCreatedUser, AdminCreateUserParams, AdminGeneratedLink, AdminGenerateLinkParams, AdminListUsersParams, AdminUpdateUserParams, AdminUserList, BASE } from "./types.js";

const userPath = (id: string) => `${BASE}/users/${encodeURIComponent(id)}`;

/** User administration, `client.auth.admin`. Secret key only: never ship it to a browser. */
export class AuthAdminClient {
    /** Users' second factors. */
    readonly mfa: AuthAdminMfaClient;

    constructor(private readonly http: HttpClient) {
        this.mfa = new AuthAdminMfaClient(http);
    }

    /** The link (or code) an auth email would carry, returned instead of sent. */
    generateLink(params: AdminGenerateLinkParams): Promise<MotherbaseResponse<AdminGeneratedLink>> {
        return settle(() => this.http.request<AdminGeneratedLink>(`${BASE}/generate-link`, { method: 'POST', body: params }));
    }

    /** Every user, a page at a time (`page`, `perPage`). */
    listUsers(params: AdminListUsersParams = {}): Promise<MotherbaseResponse<AdminUserList>> {
        const query = new URLSearchParams();
        if (params.page !== undefined) query.set('page', String(params.page));
        if (params.perPage !== undefined) query.set('per_page', String(params.perPage));
        const suffix = query.toString();
        return settle(() => this.http.request<AdminUserList>(`${BASE}/users${suffix ? `?${suffix}` : ''}`));
    }

    /** One user, or `{ user: null }` when the id matches none. */
    async getUserById(id: string): Promise<MotherbaseResponse<{ user: User | null }>> {
        const { data, error } = await settle(() => this.http.request<{ user: User }>(userPath(id)));
        // supabase-js answers a failed lookup with `{ user: null }`, not `null`.
        return { data: data ?? { user: null }, error };
    }

    /** Create a user directly, without the sign-up flow or its emails. */
    createUser(params: AdminCreateUserParams): Promise<MotherbaseResponse<AdminCreatedUser>> {
        return settle(() => this.http.request<AdminCreatedUser>(`${BASE}/users`, { method: 'POST', body: params }));
    }

    /** Change a user's email, password, role or profile. */
    async updateUserById(
        id: string,
        params: AdminUpdateUserParams,
    ): Promise<MotherbaseResponse<{ user: User | null }>> {
        const { data, error } = await settle(() => this.http.request<{ user: User }>(userPath(id), { method: 'PATCH', body: params }));
        return { data: data ?? { user: null }, error };
    }

    /** Delete a user. */
    deleteUser(id: string): Promise<MotherbaseResponse<{ id: string }>> {
        return settle(async () => {
            await this.http.request(userPath(id), { method: 'DELETE' });
            return { id };
        });
    }

    /** End every session this user holds, everywhere. */
    signOut(userId: string): Promise<MotherbaseResponse<{ id: string }>> {
        return settle(async () => {
            await this.http.request(`${userPath(userId)}/sign-out`, { method: 'POST' });
            return { id: userId };
        });
    }

    /** Create the account and email the temporary password to it. */
    inviteUserByEmail(
        email: string,
        options: { username?: string; role?: 'ADMIN' | 'USER' } = {},
    ): Promise<MotherbaseResponse<{ user: User; invited: boolean }>> {
        return settle(() => this.http.request<{ user: User; invited: boolean }>(`${BASE}/invite`, {
            method: 'POST',
            body: { email, ...options },
        }));
    }
}
