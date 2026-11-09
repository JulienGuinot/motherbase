export { createBrowserClient } from './browser.js';
export type { SsrOptions } from './browser.js';
export { createServerClient } from './server.js';
export { updateSession } from './middleware.js';

export { SESSION_COOKIE_KEY } from '@motherbase/client';

export type {
  MotherbaseClient,
  Session,
  User,
  ClientOptions,
  CookieMethods,
  CookieToSet,
  CookieOptions,
} from '@motherbase/client';
