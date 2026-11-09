import type { NextFunction, Request, Response } from 'express';

/**
 * Internet-wide scanners walking the host for leaked secrets and stock CMS
 * installs: `GET /.env`, `/.git/config`, `/wp-login.php`, `POST /`.
 *
 * None of these is a route here. They are answered before the logger, the
 * limiters and the auth stack see them, so bot paths never rank among the
 * API's most failing endpoints on the Logs screen.
 *
 * Only the first path segment is inspected. Every real route lives under a
 * named prefix (`/api`, `/rest`, `/storage`, `/auth`…), and a storage object
 * key can legitimately be `.env` or `index.php` further down a path.
 */
const PROBE_SEGMENT = /^(?:\.(?!well-known$).+|wp-.*|wordpress|phpmyadmin|cgi-bin|.+\.(?:php\d?|aspx?|jsp|cgi))$/i;

export function isScannerProbe(method: string, path: string): boolean {
  // The root serves a GET descriptor and nothing else.
  if (path === '/') return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  return PROBE_SEGMENT.test(path.split('/')[1] ?? '');
}

export function rejectScannerProbes(req: Request, res: Response, next: NextFunction): void {
  if (isScannerProbe(req.method, req.path)) {
    res.status(404).end();
    return;
  }
  next();
}
