/**
 * Product name shown to end users: transactional email subjects and bodies, and
 * the issuer stored in an authenticator app when a project does not set its own
 * `auth.twoFactor.issuer`. Per project, so it is read from the environment
 * rather than hardcoded: a client should never receive mail from someone
 * else's brand.
 *
 * Read from process.env directly (not config/env.ts) so the auth and email
 * layers can import it without pulling in the whole validated env module.
 */
export const APP_NAME = process.env.APP_NAME?.trim() || 'Motherbase';
