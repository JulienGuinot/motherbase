import { HTTP_ROUTES } from "@motherbase/contracts";
import type { SessionStore } from "../auth/session.js";

/** Below this much life left a JWT is not sent: it could expire in flight. */
const SEND_MARGIN_MS = 30_000;
/** Below this much life left a replacement is minted while the current one is still sent. */
const REMINT_MARGIN_MS = 60_000;
/** After a failed mint, or a JWT the server refused, wait this long before minting again. */
const RETRY_AFTER_MS = 30_000;

/**
 * The routes that accept the JWT: REST and storage. Everything else keeps the
 * session token. Auth endpoints need a session, not a JWT, and an edge function
 * receives the caller's Authorization header and may forward it to one of them.
 */
const DATA_PLANE_ROUTES = [HTTP_ROUTES.rest, HTTP_ROUTES.files, HTTP_ROUTES.storage, HTTP_ROUTES.storageV1];

export function isDataPlanePath(path: string): boolean {
    return DATA_PLANE_ROUTES.some(route =>
        path === route || path.startsWith(`${route}/`) || path.startsWith(`${route}?`));
}

interface Minted {
    jwt: string;
    /** Local clock, in milliseconds. */
    expiresAt: number;
    lifetimeMs: number;
}

/**
 * The short-lived JWT the data plane verifies without a database read, derived
 * from the stored session token.
 *
 * Held in memory only and never on the `Session`: the session token stays the
 * credential that is persisted and handed to the app. No request ever waits for
 * a mint. Until a JWT is ready the session token is sent, as before, and the
 * mint runs in the background, started by the request that found none.
 */
export class AccessTokens {
    private held: (Minted & { sessionToken: string }) | null = null;
    private minting: { sessionToken: string } | null = null;
    private failedAt = -Infinity;

    constructor(
        private readonly store: SessionStore,
        /** Fetches the mint endpoint for this session token; resolves with its JSON body. */
        private readonly mint: (sessionToken: string) => Promise<unknown>,
    ) {
        // A JWT belongs to the session it was minted for. Dropped as soon as that
        // session ends or is replaced, so it does not outlive a sign-out in memory.
        store.subscribe((_event, session) => {
            if (this.held && this.held.sessionToken !== session?.accessToken) this.held = null;
        });
    }

    /** The JWT to send instead of the session token, if a fresh one is held. Starts a mint when one is due. */
    current(): string | undefined {
        const sessionToken = this.store.get()?.accessToken;
        if (!sessionToken) return undefined;
        const held = this.held?.sessionToken === sessionToken ? this.held : null;
        const left = held ? held.expiresAt - Date.now() : 0;
        // Half the lifetime caps the re-mint window: an operator may configure a
        // one-minute JWT, which would otherwise be re-minted on every request.
        if (!held || left <= Math.min(REMINT_MARGIN_MS, held.lifetimeMs / 2)) this.startMint(sessionToken);
        return held && left > SEND_MARGIN_MS ? held.jwt : undefined;
    }

    /**
     * The server answered 401 to this JWT. Stop sending it, and back off as after
     * a failed mint: a server that does not accept JWTs on the data plane would
     * otherwise cost a second round trip on every request.
     */
    reject(jwt: string): void {
        if (this.held?.jwt === jwt) this.held = null;
        this.failedAt = Date.now();
    }

    private startMint(sessionToken: string): void {
        if (this.minting?.sessionToken === sessionToken || Date.now() - this.failedAt < RETRY_AFTER_MS) return;
        const attempt = { sessionToken };
        this.minting = attempt;
        const startedAt = Date.now();
        // Nobody awaits this promise, so every failure is caught here: a failed
        // mint means "keep sending the session token", never an error.
        void this.mint(sessionToken)
            .then(body => parseMinted(body, startedAt))
            .catch(() => null)
            .then(minted => {
                // A mint for a newer session started since: that one decides.
                if (this.minting !== attempt) return;
                this.minting = null;
                // Signed out, or signed in as someone else, while this one was in flight.
                if (this.store.get()?.accessToken !== sessionToken) return;
                if (minted) this.held = { ...minted, sessionToken };
                else this.failedAt = Date.now();
            });
    }
}

/**
 * `{ token }` from the mint endpoint, or null when it is not a usable JWT.
 *
 * The lifetime is measured from the JWT's own `iat` and anchored to the local
 * clock when the mint started, so a device clock that disagrees with the
 * server's neither sends expired JWTs nor discards fresh ones.
 */
export function parseMinted(body: unknown, mintedAt: number): Minted | null {
    const jwt = (body as { token?: unknown } | null)?.token;
    if (typeof jwt !== 'string') return null;
    const claims = decodePayload(jwt);
    if (typeof claims?.exp !== 'number') return null;
    const issuedAt = typeof claims.iat === 'number' ? claims.iat : mintedAt / 1000;
    const lifetimeMs = (claims.exp - issuedAt) * 1000;
    return lifetimeMs > SEND_MARGIN_MS ? { jwt, expiresAt: mintedAt + lifetimeMs, lifetimeMs } : null;
}

/** The payload segment, base64url-decoded with `atob`, which browsers, Node and Hermes all have. */
function decodePayload(jwt: string): { exp?: unknown; iat?: unknown } | null {
    const segment = jwt.split('.')[1];
    if (!segment) return null;
    try {
        const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))) as { exp?: unknown; iat?: unknown };
    } catch {
        return null;
    }
}
