import BaseContext from '../context/base-context';
import {
  remoteJwks,
  verifyThirdPartyToken,
  type ThirdPartyCaller,
  type ThirdPartyProvider,
} from '../auth/third-party';

/** Supabase Third-Party Auth, against the live auth.thirdParty settings. */
export class ThirdPartyAuthService extends BaseContext {
  // Keys are cached per JWKS URL for the life of the process (see remoteJwks).
  private readonly jwks = remoteJwks();

  async verify(token: string): Promise<ThirdPartyCaller | null> {
    const { providers } = await this.di.SettingsService.get<{ providers: ThirdPartyProvider[] }>('auth.thirdParty');
    if (!providers?.some(p => p.enabled)) return null;
    return verifyThirdPartyToken(token, providers, this.jwks);
  }
}
