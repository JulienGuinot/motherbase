'use client';

import { useMemo, useState } from 'react';
import { Check, Lock, Search } from 'lucide-react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { Field } from '@/shared/ui/Field';
import { SkeletonList } from '@/shared/ui/Skeleton';
import { EmptyState } from '@/shared/ui/EmptyState';
import { useGitRepos } from '@/features/database/hooks/useGitRepo';
import type { GitLinkInput, GitLinkStatus, GitRepoOption } from '@/features/database/api/git.api';

/**
 * Pick the repository, the branch and the directory of `.sql` files.
 *
 * Two steps, not one form: choosing a repository is a search through a list of
 * a hundred, and settling the branch and path is three fields. Showing both at
 * once buries the fields under the list.
 */
export function GitRepoPickerModal({
  status,
  saving,
  onClose,
  onSubmit,
}: {
  status: GitLinkStatus;
  saving: boolean;
  onClose: () => void;
  onSubmit: (input: GitLinkInput) => void;
}) {
  const reposQuery = useGitRepos(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<GitRepoOption | null>(null);
  const [branch, setBranch] = useState(status.branch);
  const [migrationsPath, setMigrationsPath] = useState(status.migrationsPath);

  const repos = useMemo(() => {
    const term = search.trim().toLowerCase();
    const all = reposQuery.data ?? [];
    return term ? all.filter(repo => repo.fullName.toLowerCase().includes(term)) : all;
  }, [reposQuery.data, search]);

  const choose = (repo: GitRepoOption) => {
    setSelected(repo);
    // The repo's own default branch is the right guess, and it is almost never
    // the string that happened to be in the form before.
    setBranch(repo.defaultBranch);
  };

  return (
    <Modal onClose={onClose} width="620px">
      <ModalHeader
        eyebrow="GitHub"
        title={selected ? selected.fullName : 'Choose a repository'}
        description={
          selected
            ? 'Every .sql file in this directory is applied in file-name order, once. Push to the branch to deploy.'
            : `Repositories ${status.accountLogin ?? 'you'} can push to.`
        }
      />

      <ModalBody className="space-y-4">
        {selected ? (
          <>
            <Field label="Branch" required hint="Only pushes to this branch trigger a deploy.">
              <input className="input w-full" value={branch} onChange={e => setBranch(e.target.value)} />
            </Field>
            <Field
              label="Migrations directory"
              hint="Relative to the repository root. Leave empty to use the root itself."
            >
              <input
                className="input w-full"
                value={migrationsPath}
                placeholder="migrations"
                onChange={e => setMigrationsPath(e.target.value)}
              />
            </Field>
            <div
              className="border hairline p-3 text-[11px]"
              style={{ borderRadius: 'var(--radius-sm)', color: 'var(--text-mute)' }}
            >
              A file is one migration, named by its file name, <span className="mono">20260816_add_orders.sql</span>{' '}
, and applied in that order. Put rollback SQL after a{' '}
              <span className="mono">-- @down</span> line if you want to be able to roll it back from this page.
            </div>
          </>
        ) : (
          <>
            <div
              className="flex items-center gap-2 border hairline-strong px-2 py-1.5"
              style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
            >
              <Search size={12} style={{ color: 'var(--text-mute)' }} />
              <input
                autoFocus
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search repositories..."
                className="w-full bg-transparent text-[12px] outline-none placeholder:opacity-50"
              />
            </div>

            {reposQuery.isLoading && <SkeletonList rows={6} height={30} />}

            {!reposQuery.isLoading && repos.length === 0 && (
              <EmptyState
                mascot="looking-map"
                title="No repositories"
                description={
                  search
                    ? 'Nothing matches that search.'
                    : 'The connected account has no repository it can push to.'
                }
              />
            )}

            <ul className="max-h-[320px] overflow-auto">
              {repos.map(repo => (
                <li key={repo.fullName}>
                  <button
                    onClick={() => choose(repo)}
                    className="flex w-full items-center gap-2 border-b hairline px-2 py-2 text-left text-[12px] last:border-b-0"
                  >
                    <span className="mono min-w-0 flex-1 truncate">{repo.fullName}</span>
                    {repo.private && <Lock size={11} style={{ color: 'var(--text-mute)' }} />}
                    <span className="chip text-[10px]">{repo.defaultBranch}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </ModalBody>

      <ModalFooter>
        {selected && (
          <button className="btn" onClick={() => setSelected(null)} disabled={saving}>
            Back
          </button>
        )}
        <button className="btn" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={!selected || !branch.trim() || saving}
          onClick={() =>
            selected &&
            onSubmit({
              owner: selected.owner,
              repo: selected.name,
              branch: branch.trim(),
              migrationsPath: migrationsPath.trim(),
            })
          }
        >
          <Check size={12} /> {saving ? 'Connecting…' : 'Connect'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
