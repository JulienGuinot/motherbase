import { createAuthClient as createBetterAuthClient } from 'better-auth/client';
import { anonymousClient, emailOTPClient, jwtClient, magicLinkClient, organizationClient, phoneNumberClient, twoFactorClient } from 'better-auth/client/plugins';
import { apiKeyClient } from '@better-auth/api-key/client';
import { passkeyClient } from '@better-auth/passkey/client';
import { ssoClient } from '@better-auth/sso/client';
import { HTTP_ROUTES } from '@motherbase/contracts';
import { HttpClient } from '../http/index.js';
import { withoutTrailingSlash } from '../http/utils.js';
import { motherbaseClient } from './motherbase-plugin.js';
import { SessionStore } from './session.js';
import type { AuthClient, AuthClientOptions, AuthPlugins } from './types.js';

export function createAuthClient(http: HttpClient, store: SessionStore, options: AuthClientOptions): AuthClient {
  // Must stay in step with `AuthPlugins`; the annotation makes the compiler check it.
  const plugins: AuthPlugins = [
    anonymousClient(),
    emailOTPClient(),
    magicLinkClient(),
    phoneNumberClient(),
    twoFactorClient(),
    organizationClient({ teams: { enabled: true } }),
    jwtClient(),
    passkeyClient(),
    ssoClient(),
    apiKeyClient(),
    motherbaseClient(http, store, options),
  ];
  return createBetterAuthClient({
    baseURL: `${withoutTrailingSlash(options.url)}${HTTP_ROUTES.auth}`,
    fetchOptions: {
      customFetchImpl: http.observedFetch(options.fetch),
      headers: options.headers,
      auth: { type: 'Bearer', token: async () => (await store.hydrate())?.accessToken },
    },
    plugins,
  });
}
