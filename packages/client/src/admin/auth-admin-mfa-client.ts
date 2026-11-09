import { HttpClient } from "../http/index.js";
import { settle } from "../http/utils.js";
import { MotherbaseResponse } from "../types.js";
import { AdminMfaFactor, BASE } from "./types.js";

/** A user's second factors (TOTP, passkeys), `client.auth.admin.mfa`. Secret key only. */
export class AuthAdminMfaClient {
    constructor(private readonly http: HttpClient) { }

    /** The second factors a user has enrolled. */
    listFactors(params: { userId: string }): Promise<MotherbaseResponse<{ factors: AdminMfaFactor[] }>> {
        return settle(() => this.http.request<{ factors: AdminMfaFactor[] }>(
            `${BASE}/users/${encodeURIComponent(params.userId)}/factors`,
        ));
    }

    /** Remove one of a user's second factors, e.g. to recover a lost device. */
    deleteFactor(params: { userId: string; id: string }): Promise<MotherbaseResponse<{ id: string }>> {
        return settle(() => this.http.request<{ id: string }>(
            `${BASE}/users/${encodeURIComponent(params.userId)}/factors/${encodeURIComponent(params.id)}`,
            { method: 'DELETE' },
        ));
    }
}
