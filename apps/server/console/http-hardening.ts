import type { Express, Request, Response } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { parseTrustProxy } from '../lib/trust-proxy';

export function applyHttpHardening(app: Express): void {
  // The console sits behind Traefik (deploy/console), so without this every
  // request looks like it came from the proxy and the auth limiter would key
  // all callers into a single bucket. Opt-in for the same reason as the project
  // app: trusting X-Forwarded-For with no proxy in front lets clients forge IPs.
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY ?? '');
  if (trustProxy !== false) app.set('trust proxy', trustProxy);

  // The console drives Docker and proxies admin SQL, so it must not be framed
  // (clickjacking) or sniffed. A full script CSP is not set: the Next.js studio
  // ships inline bootstrap scripts, so a strict one needs per-request nonces.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: helmet.contentSecurityPolicy.dangerouslyDisableDefaultSrc,
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          objectSrc: ["'none'"],
        },
      },
    }),
  );
}

/**
 * Credential endpoints guard the `owner` account, which can create/destroy
 * projects, run SQL through the admin proxy and manage users. Unlimited
 * guessing against it is the single highest-value target on the platform.
 */
export function createAuthLimiter() {
  return rateLimit({
    windowMs: Number(process.env.CONSOLE_RATE_LIMIT_WINDOW_MIN ?? 15) * 60 * 1000,
    limit: Number(process.env.CONSOLE_RATE_LIMIT_AUTH_MAX ?? 20),
    standardHeaders: true,
    legacyHeaders: false,
    // The UI polls get-session on every page; it is not a credential guess.
    skip: (req: Request) => req.path.endsWith('/get-session'),
    handler: (_req: Request, res: Response) =>
      res.status(429).json({ success: false, message: 'Too many attempts, please try again later.' }),
  });
}
