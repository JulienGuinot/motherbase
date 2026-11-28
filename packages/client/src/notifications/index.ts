import { HTTP_ROUTES } from "@motherbase/contracts";
import { HttpClient } from "../http/index.js";
import type { MotherbaseResponse } from "../index.js";
import { toError } from "../http/utils.js";

export type DevicePlatform = 'ios' | 'android' | 'web';

export interface PushMessage {
    title: string;
    body: string;
    /** Flat string to string map, delivered with the notification. */
    data?: Record<string, string>;
}

export interface PushResult {
    token: string;
    success: boolean;
    error?: string;
    /** The provider called the token permanently invalid; it was removed. */
    invalid?: boolean;
}

/**
 * Push notifications. A signed-in app registers the device token it got from
 * FCM or APNs; the project's back end (a secret API key, or a user with the
 * ADMIN role) sends to one user or to many.
 */
export class NotificationsClient {
    constructor(private readonly http: HttpClient) { }

    /** Attach this device's push token to the signed-in user. Registering the same token again moves it. */
    registerDevice(token: string, platform: DevicePlatform): Promise<MotherbaseResponse<unknown>> {
        return this.call(HTTP_ROUTES.devices, 'POST', { token, platform });
    }

    /** Detach a push token from the signed-in user, typically on sign-out. */
    unregisterDevice(token: string): Promise<MotherbaseResponse<unknown>> {
        return this.call(HTTP_ROUTES.devices, 'DELETE', { token });
    }

    /**
     * Send to every device of one user (`userId`) or of up to 1000 (`userIds`).
     * Needs a secret API key or a user with the ADMIN role.
     */
    send(
        target: { userId: string } | { userIds: string[] },
        message: PushMessage,
    ): Promise<MotherbaseResponse<{ results: PushResult[]; pruned: number }>> {
        return this.call(HTTP_ROUTES.notificationsSend, 'POST', { ...target, ...message });
    }

    private async call<T>(path: string, method: 'POST' | 'DELETE', body: unknown): Promise<MotherbaseResponse<T>> {
        try {
            return { data: await this.http.request<T>(path, { method, body }), error: null };
        } catch (err) {
            return { data: null, error: toError(err) };
        }
    }
}
