'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, GitBranch, RefreshCw, Settings2, Unplug } from 'lucide-react';
import { BrandLogo } from '@/shared/ui/BrandLogo';
import { Skeleton } from '@/shared/ui/Skeleton';
import { WriteButton } from '@/shared/ui/WriteButton';
import SettingsForm from '@/shared/ui/SettingsForm';
import { BASE_PATH } from '@/shared/lib/project';
import { useGitStatus, useGitRepoAdmin } from '@/features/database/hooks/useGitRepo';
import { GitRepoPickerModal } from '@/features/database/components/GitRepoPickerModal';

/**
 * The connected repository, at the top of the Migrations page.
 *
 * Four states, and each one says what to do next rather than what is missing:
 *   1. no OAuth App configured -> the credentials form, inline
 *   2. configured, no account   -> "Connect GitHub"
 *   3. account, no repository   -> "Choose a repository"
 *   4. linked                   -> repo, branch, path, last deploy, Deploy now
 */
export function GitRepoCard() {
  const statusQuery = useGitStatus();
  const git = useGitRepoAdmin();
  const [picking, setPicking] = useState(false);
  const [configuring, setConfiguring] = useState(false);

  const status = statusQuery.data;
  // The callback URL the operator must register. Built from the browser's own
  // origin, which is by definition the one GitHub will be redirecting back to.
  const callbackHint =
    typeof window === 'undefined' ? `${BASE_PATH}/git/callback` : `${window.location.origin}${BASE_PATH}/git/callback`;

  if (statusQuery.isLoading || !status) {
    return (
      <div className="card flex items-center gap-3 p-5">
        <Skeleton style={{ height: 16, width: 16, borderRadius: 4 }} />
        <Skeleton style={{ height: 14, width: 220 }} />
      </div>
    );
  }

  const header = (
    <div className="flex min-w-0 items-center gap-3">
      <BrandLogo brand="github" label="GitHub" size={18} />
      <div className="min-w-0">
        <div className="text-[13px]" style={{ fontWeight: 600 }}>
          {status.connected ? `${status.owner}/${status.repo}` : 'Git repository'}
        </div>
        <div className="truncate text-[12px]" style={{ color: 'var(--text-mute)' }}>
          {status.connected
            ? `Pushes to ${status.branch} apply new .sql files from ${status.migrationsPath || 'the repository root'}`
            : 'Deploy migrations from a GitHub repository on every push.'}
        </div>
      </div>
    </div>
  );

  // Nothing to connect to until the OAuth App exists, so the form is here rather
  // than behind a link to Settings: the operator is three fields away from the
  // thing they came to do, and sending them elsewhere to find them loses most of
  // them on the way.
  if (!status.configured) {
    return (
      <div className="card p-5">
        <div className="flex flex-wrap items-center gap-3">
          {header}
          <button className="btn sm:ml-auto" onClick={() => setConfiguring(v => !v)}>
            <Settings2 size={12} /> {configuring ? 'Hide setup' : 'Set up GitHub'}
          </button>
        </div>
        {configuring && (
          <div className="mt-4 border-t hairline pt-4">
            <p className="mb-3 text-[12px]" style={{ color: 'var(--text-mute)' }}>
              Create an OAuth App under GitHub → Settings → Developer settings → OAuth Apps. Set its Authorization
              callback URL to <span className="mono">{callbackHint}</span> and paste the credentials here.
            </p>
            <SettingsForm group="git.github" onSaved={() => statusQuery.refetch()} />
          </div>
        )}
      </div>
    );
  }

  if (!status.accountLogin) {
    return (
      <div className="card flex flex-wrap items-center gap-3 p-5">
        {header}
        <WriteButton
          capability="secrets.manage"
          className="btn btn-primary sm:ml-auto"
          onClick={git.connect}
          disabled={git.connecting}
        >
          <BrandLogo brand="github" label="GitHub" size={13} /> {git.connecting ? 'Redirecting…' : 'Connect GitHub'}
        </WriteButton>
      </div>
    );
  }

  return (
    <>
      <div className="card p-5">
        <div className="flex flex-wrap items-center gap-3">
          {header}

          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            {status.connected && (
              <WriteButton
                capability="secrets.manage"
                className="btn"
                onClick={git.sync}
                disabled={git.syncing}
                title="Import and apply any .sql file that is not applied yet"
              >
                <RefreshCw size={12} /> {git.syncing ? 'Deploying…' : 'Deploy now'}
              </WriteButton>
            )}
            <WriteButton capability="secrets.manage" className="btn" onClick={() => setPicking(true)}>
              <GitBranch size={12} /> {status.connected ? 'Change' : 'Choose a repository'}
            </WriteButton>
            <WriteButton
              capability="secrets.manage"
              className="btn"
              style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
              onClick={() => git.confirmDisconnect(status.connected ? `${status.owner}/${status.repo}` : 'GitHub')}
              disabled={git.disconnecting}
            >
              <Unplug size={12} /> Disconnect
            </WriteButton>
          </div>
        </div>

        {/* The webhook is what makes this automatic rather than a button, so its
            absence is worth naming instead of leaving the card looking healthy. */}
        {status.connected && !status.webhookInstalled && (
          <div className="mt-4 flex items-start gap-2 text-[12px]" style={{ color: 'var(--amber)' }}>
            <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
            No push webhook is installed, so deploys only happen when you press Deploy now. Reconnect the repository to
            reinstall it.
          </div>
        )}

        {status.lastSyncAt && (
          <div className="mt-4 flex items-start gap-2 border-t hairline pt-3 text-[12px]">
            {status.lastSyncStatus === 'ok' ? (
              <CheckCircle2 size={13} style={{ color: 'var(--green)', flexShrink: 0, marginTop: 1 }} />
            ) : (
              <AlertTriangle size={13} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 1 }} />
            )}
            <div className="min-w-0">
              <span style={{ color: 'var(--text-dim)' }}>{status.lastSyncMessage}</span>
              <span style={{ color: 'var(--text-mute)' }}>
                {' · '}
                {new Date(status.lastSyncAt).toLocaleString()}
                {status.lastSyncSha ? ` · ${status.lastSyncSha.slice(0, 7)}` : ''}
              </span>
            </div>
          </div>
        )}
      </div>

      {picking && (
        <GitRepoPickerModal
          status={status}
          saving={git.linking}
          onClose={() => setPicking(false)}
          onSubmit={input => {
            git.link(input);
            setPicking(false);
          }}
        />
      )}
    </>
  );
}
