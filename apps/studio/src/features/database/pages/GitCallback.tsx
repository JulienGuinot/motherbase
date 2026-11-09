'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { BrandLogo } from '@/shared/ui/BrandLogo';
import { projectPath } from '@/shared/lib/project';
import { useGitRepoAdmin } from '@/features/database/hooks/useGitRepo';

/**
 * Where GitHub returns the browser after an OAuth authorization.
 *
 * The page exists so the code exchange happens over the Studio's own admin
 * session: GitHub redirects a browser, which carries no bearer token, so the
 * server cannot accept the redirect directly without an unauthenticated
 * endpoint that hands out access tokens. Here the code is simply POSTed to
 * `/admin/git/callback` like any other admin call, and the operator is sent back
 * to Migrations.
 */
export default function GitCallback() {
  const router = useRouter();
  const params = useSearchParams();
  const git = useGitRepoAdmin();
  // Everything GitHub put in the URL is derived, not state: reading it during
  // render keeps the effect down to the one thing that is genuinely async.
  const denied = params.get('error_description') ?? params.get('error');
  const code = params.get('code');
  const state = params.get('state');
  const [failure, setFailure] = useState<string | null>(null);

  const error =
    denied ?? (!code || !state ? 'GitHub did not return an authorization code.' : failure);

  // React mounts effects twice in development, and an authorization code is
  // single-use: the second exchange would fail and overwrite a good result with
  // an error.
  const started = useRef(false);

  useEffect(() => {
    if (started.current || denied || !code || !state) return;
    started.current = true;
    git
      .completeAuthorization(code, state)
      .then(() => router.replace(projectPath('/database/migrations')))
      .catch(() => setFailure('The authorization could not be completed. Start again from the Migrations page.'));
  }, [git, denied, code, state, router]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
      {error ? (
        <>
          <AlertTriangle size={20} style={{ color: 'var(--danger)' }} />
          <p className="text-[13px]" style={{ color: 'var(--text)' }}>{error}</p>
          <button className="btn" onClick={() => router.replace(projectPath('/database/migrations'))}>
            Back to Migrations
          </button>
        </>
      ) : (
        <>
          <BrandLogo brand="github" label="GitHub" size={22} />
          <p className="text-[13px]" style={{ color: 'var(--text-mute)' }}>Finishing the GitHub connection…</p>
        </>
      )}
    </div>
  );
}
