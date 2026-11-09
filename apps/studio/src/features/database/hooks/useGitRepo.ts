'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { gitApi, type GitLinkInput, type GitSyncResult } from '@/features/database/api/git.api';

export function useGitStatus() {
  return useQuery({ queryKey: ['git', 'status'], queryFn: gitApi.status });
}

/** The operator's repository list, only fetched once the picker opens. */
export function useGitRepos(enabled: boolean) {
  return useQuery({ queryKey: ['git', 'repos'], queryFn: gitApi.repos, enabled });
}

/** Connecting, linking, syncing and disconnecting the repository. */
export function useGitRepoAdmin() {
  const qc = useQueryClient();
  const toast = useToast();

  // A sync creates and applies migrations, so the migrations list is stale too.
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['git'] });
    qc.invalidateQueries({ queryKey: ['migrations'] });
  };
  const fail = (title: string) => (e: unknown) =>
    toast.push({ kind: 'error', title, message: getErrorMessage(e) });

  const startAuthorization = useMutation({
    mutationFn: gitApi.authorizeUrl,
    // A full page assignment, not a router push: the destination is github.com.
    onSuccess: url => window.location.assign(url),
    onError: fail('Could not start the GitHub authorization'),
  });

  const complete = useMutation({
    mutationFn: ({ code, state }: { code: string; state: string }) => gitApi.completeAuthorization(code, state),
    onSuccess: status => {
      invalidate();
      toast.push({ kind: 'success', title: `GitHub connected as ${status.accountLogin}` });
    },
    onError: fail('GitHub connection failed'),
  });

  const link = useMutation({
    mutationFn: (input: GitLinkInput) => gitApi.link(input),
    onSuccess: status => {
      invalidate();
      toast.push({
        kind: 'success',
        title: `Connected ${status.owner}/${status.repo}`,
        message: `Pushes to ${status.branch} will apply new migrations.`,
      });
    },
    onError: fail('Could not connect the repository'),
  });

  const sync = useMutation({
    mutationFn: gitApi.sync,
    onSuccess: (result: GitSyncResult) => {
      invalidate();
      if (result.failed) {
        toast.push({
          kind: 'error',
          title: `Sync stopped at ${result.failed.name || 'the repository'}`,
          message: result.failed.message,
        });
        return;
      }
      toast.push({
        kind: 'success',
        title: result.applied.length ? `Applied ${result.applied.length} migration(s)` : 'Already up to date',
        message: result.applied.join(', ') || undefined,
      });
    },
    onError: fail('Sync failed'),
  });

  const unlink = useMutation({
    mutationFn: gitApi.unlink,
    onSuccess: () => {
      invalidate();
      toast.push({ kind: 'success', title: 'Repository disconnected' });
    },
    onError: fail('Disconnect failed'),
  });

  return {
    connect: () => startAuthorization.mutate(),
    connecting: startAuthorization.isPending,
    completeAuthorization: (code: string, state: string) => complete.mutateAsync({ code, state }),
    link: (input: GitLinkInput) => link.mutate(input),
    linking: link.isPending,
    sync: () => sync.mutate(),
    syncing: sync.isPending,
    confirmDisconnect: async (label: string) => {
      const ok = await confirmDialog({
        title: `Disconnect ${label}?`,
        // Said explicitly: an operator reaching for this button is usually
        // worried about the schema, and the answer is that nothing happens to it.
        description:
          'The push webhook is removed and the stored GitHub token is deleted. Migrations already applied stay applied.',
        confirmLabel: 'Disconnect',
        tone: 'danger',
      });
      if (ok) unlink.mutate();
    },
    disconnecting: unlink.isPending,
  };
}
