import { createEmailVerificationToken } from 'better-auth/api';
import { z } from 'zod';
import BaseContext from '../../context/base-context';
import { HttpException } from '../../exceptions/http-exception';
import { maskRow } from '../../constants/admin.constants';
import type { AuthMessage } from '../../auth/hooks/send-hook';

/** supabase-js `auth.admin.generateLink` params, as the SDK sends them. */
export const generateLinkSchema = z.object({
  type: z.enum(['signup', 'invite', 'magiclink', 'recovery', 'email_change_current', 'email_change_new']),
  email: z.string().email(),
  password: z.string().optional(),
  newEmail: z.string().email().optional(),
  options: z.object({ redirectTo: z.string().optional(), data: z.record(z.string(), z.unknown()).optional() }).optional(),
});

export type GenerateLinkParams = z.infer<typeof generateLinkSchema>;

export interface GeneratedLink {
  properties: {
    action_link: string | null;
    email_otp: string | null;
    hashed_token: string | null;
    redirect_to: string | null;
    verification_type: string;
  };
  user: Record<string, unknown> | null;
}

/**
 * `auth.admin.generateLink`: the link (or code) an auth email would carry,
 * returned to trusted server code instead of sent, so it can deliver it
 * through its own channel.
 *
 * Each type runs the real Better Auth flow inside AuthManager.captureMessages,
 * so the link is exactly the one a user would have received and verifies
 * through the same endpoint:
 *
 *   signup     create the user with the password, return the verification link
 *   invite     create the user (no password), return a magic sign-in link
 *   magiclink  a magic sign-in link (the user is created on first use)
 *   recovery   the password-reset code: recovery here is code-based, so
 *              `email_otp` is set and `action_link` is null
 *
 * `email_change_*` are refused: permanent users do not change their address
 * through this project's auth (see plugins/user-credentials.ts).
 */
export class AuthLinkService extends BaseContext {
  async generate(params: GenerateLinkParams): Promise<GeneratedLink> {
    const email = params.email.toLowerCase();
    const redirectTo = params.options?.redirectTo;
    const auth = await this.di.AuthManager.current();
    const api = auth.api as any;
    const existing = await this.di.prisma.user.findUnique({ where: { email } });

    switch (params.type) {
      case 'signup': {
        if (!params.password) throw new HttpException('password is required for a signup link', 400);
        if (existing) throw new HttpException('A user with this email address has already been registered', 422);
        await this.di.AuthManager.captureMessages(() =>
          api.signUpEmail({ body: { email, password: params.password, name: email, ...(params.options?.data ?? {}) } }),
        );
        const ctx = await auth.$context;
        const token = await createEmailVerificationToken(ctx.secret, email);
        const query = new URLSearchParams({ token, ...(redirectTo ? { callbackURL: redirectTo } : {}) });
        return this.result('signup', `${ctx.baseURL}/verify-email?${query}`, null, token, redirectTo, email);
      }
      case 'invite':
      case 'magiclink': {
        if (params.type === 'invite') {
          if (existing) throw new HttpException('A user with this email address has already been registered', 422);
          // Same generated username every Better Auth sign-up gets (see AuthManager).
          const username = (await this.di.UserService.getRandomUsername()).data.username;
          await this.di.prisma.user.create({ data: { email, name: email, username } });
        }
        const { messages } = await this.di.AuthManager.captureMessages(() =>
          api.signInMagicLink({ body: { email, ...(redirectTo ? { callbackURL: redirectTo } : {}) }, headers: new Headers() }),
        );
        const url = this.captured(messages, 'magic-link')?.url;
        if (!url) throw new HttpException('Magic links are disabled for this project', 400);
        return this.result(params.type, url, null, new URL(url).searchParams.get('token'), redirectTo, email);
      }
      case 'recovery': {
        if (!existing) throw new HttpException('User not found', 404);
        const { messages } = await this.di.AuthManager.captureMessages(() =>
          api.requestPasswordResetEmailOTP({ body: { email } }),
        );
        const otp = this.captured(messages, 'email-otp')?.otp;
        if (!otp) throw new HttpException('Email OTP is disabled for this project', 400);
        return this.result('recovery', null, otp, null, redirectTo, email);
      }
      default:
        throw new HttpException(`generateLink type '${params.type}' is not supported: users do not change their email address here`, 400);
    }
  }

  private captured(messages: AuthMessage[], kind: string): AuthMessage | undefined {
    return messages.find(message => message.kind === kind);
  }

  private async result(
    type: string,
    actionLink: string | null,
    otp: string | null,
    hashedToken: string | null,
    redirectTo: string | undefined,
    email: string,
  ): Promise<GeneratedLink> {
    const user = await this.di.prisma.user.findUnique({ where: { email } });
    return {
      properties: {
        action_link: actionLink,
        email_otp: otp,
        hashed_token: hashedToken,
        redirect_to: redirectTo ?? null,
        verification_type: type,
      },
      user: user ? maskRow(user) : null,
    };
  }
}
