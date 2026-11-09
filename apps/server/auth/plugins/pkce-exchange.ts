import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { PKCE_CODE_TTL_MS, createPkceCodec, verifierMatches } from '../pkce';

/** Prisma's duplicate-key code. A second exchange of one code lands here. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * `POST /exchange-code`: GoTrue's `POST /token?grant_type=pkce`, what
 * `auth.exchangeCodeForSession(code)` calls. Trades the `?code=` a PKCE
 * redirect carried (minted in ../oauth-redirect.ts) plus the verifier behind
 * its challenge for the session, in the `{ token, user }` shape of a sign-in.
 */
export function pkceExchange(prisma: PrismaClient, now: () => number = Date.now) {
  // A marker is dead weight the moment the code behind it has expired, so the
  // table bounds itself from the exchange path and needs no scheduler of its
  // own -- and no Enabled switch that could be turned off while codes are
  // still being minted. One sweep per code lifetime per process.
  let nextSweepAt = 0;
  const sweepExpired = async () => {
    if (now() < nextSweepAt) return;
    nextSweepAt = now() + PKCE_CODE_TTL_MS;
    // A sweep is maintenance: its failure must never fail a valid exchange.
    await prisma.pkceCode.deleteMany({ where: { expiresAt: { lt: new Date(now()) } } }).catch(() => {});
  };

  return {
    id: 'pkce-exchange',
    endpoints: {
      exchangeCode: createAuthEndpoint(
        '/exchange-code',
        {
          method: 'POST',
          body: z.object({ auth_code: z.string().min(1), code_verifier: z.string().min(43).max(128) }),
        },
        async ctx => {
          const invalid = () => new APIError('BAD_REQUEST', { message: 'Invalid or expired PKCE code.' });
          const opened = createPkceCodec(ctx.context.secret).open(ctx.body.auth_code);
          if (!opened || !verifierMatches(ctx.body.code_verifier, opened.challenge, opened.method)) throw invalid();

          // Single use. Inserting the marker IS the claim: the primary key is
          // the hash of the code, so of two concurrent exchanges one gets the
          // row and the other gets P2002. A read followed by a write let both
          // through, because nothing held between them (SEC-16).
          const codeHash = createHash('sha256').update(ctx.body.auth_code).digest('base64url');
          try {
            await prisma.pkceCode.create({
              data: { codeHash, expiresAt: new Date(now() + PKCE_CODE_TTL_MS) },
            });
          } catch (error) {
            if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw invalid();
            // A database failure is not a verdict on the code: let it be a 500
            // rather than telling the caller its valid code was rejected.
            throw error;
          }
          await sweepExpired();



          
          // The cookie value is `token.signature`; the session row is keyed on the token.
          const found = await ctx.context.internalAdapter.findSession(opened.token.split('.')[0]);
          if (!found || found.session.expiresAt < new Date()) throw invalid();
          return ctx.json({ token: opened.token, user: found.user });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
