'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { GitBranch, GitMerge, Pause, Play, Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { Badge, type Tone } from '@/shared/ui/Badge';
import { EmptyState } from '@/shared/ui/EmptyState';
import { Checkbox, Field } from '@/shared/ui/Field';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { Note } from '@/shared/ui/Row';
import { Section } from '@/shared/ui/Section';
import { Skeleton } from '@/shared/ui/Skeleton';
import { WriteButton } from '@/shared/ui/WriteButton';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { QueryFailure } from '@/shared/ui/QueryState';
import { formatRelativeTime } from '@/shared/lib/format';
import { useProjectId } from '@/shared/hooks/useRouteParam';
import { useBranchDetail, useBranches } from '@/features/projects/hooks/useBranches';
import type { Branch } from '@/features/projects/api/hosting.api';

const STATUS_TONE: Record<Branch['status'], Tone> = {
  creating: 'info',
  seeding: 'info',
  active: 'success',
  failed: 'danger',
};

/** Ahead/behind for one branch, fetched only when its row is opened. */
function MigrationDrift({ project, branch }: { project: string; branch: string }) {
  const detail = useBranchDetail(project, branch);
  if (detail.isLoading) return <Skeleton style={{ height: 14, width: '40%' }} />;
  const drift = detail.data?.migrations;
  if (!drift) return <span style={{ color: 'var(--text-mute)' }}>Migration drift is known once both projects are running.</span>;
  const list = (names: string[]) => (names.length ? names.join(', ') : 'none');
  return (
    <span className="mono" style={{ color: 'var(--text-dim)' }}>
      ahead: {list(drift.ahead)} · behind: {list(drift.behind)}
    </span>
  );
}

function BranchRow({ project, branch, busy, onAction, onDelete, onOpen }: {
  project: string;
  branch: Branch;
  busy: boolean;
  onAction: (action: 'merge' | 'rebase' | 'reset' | 'pause' | 'unpause') => void;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ready = branch.status === 'active';
  return (
    <div className="px-5 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <GitBranch size={14} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
        <button type="button" className="min-w-0 text-left" onClick={() => setOpen(v => !v)} disabled={branch.isDefault}>
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px]" style={{ color: 'var(--text)' }}>{branch.name}</span>
            {branch.isDefault ? <Badge tone="neutral">production</Badge> : <Badge tone={STATUS_TONE[branch.status]} dot>{branch.status}</Badge>}
            {!branch.running && ready && <Badge tone="warn">paused</Badge>}
            {branch.withData && !branch.isDefault && <Badge tone="info">with data</Badge>}
          </div>
          <div className="mono mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-mute)' }}>
            {branch.domain}{branch.gitBranch ? ` · ${branch.gitBranch}` : ''} · {formatRelativeTime(branch.createdAt)}
          </div>
        </button>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" className="btn btn-ghost" onClick={onOpen} disabled={!ready && !branch.isDefault}>Open</button>
          {!branch.isDefault && (
            <>
              <WriteButton capability="content.write" className="btn btn-ghost" disabled={busy || !ready || !branch.running}
                title="Apply the parent's newer migrations here" onClick={() => onAction('rebase')}>
                <RefreshCw size={13} /> Rebase
              </WriteButton>
              <WriteButton capability="content.write" className="btn btn-ghost" disabled={busy || !ready || !branch.running}
                title="Apply this branch's new migrations to production" onClick={() => onAction('merge')}>
                <GitMerge size={13} /> Merge
              </WriteButton>
              <WriteButton capability="runtime.manage" className="btn btn-ghost" disabled={busy || !ready}
                title={branch.running ? 'Stop the stack, keep its data' : 'Start the stack again'}
                onClick={() => onAction(branch.running ? 'pause' : 'unpause')}>
                {branch.running ? <Pause size={13} /> : <Play size={13} />}
              </WriteButton>
              <WriteButton capability="runtime.manage" className="btn btn-ghost" disabled={busy || branch.status === 'creating' || branch.status === 'seeding'}
                title="Recreate from production as it is now" onClick={() => onAction('reset')}>
                <RotateCcw size={13} />
              </WriteButton>
              <WriteButton capability="project.delete" className="btn btn-ghost" disabled={busy} title="Delete this branch" onClick={onDelete}>
                <Trash2 size={13} />
              </WriteButton>
            </>
          )}
        </div>
      </div>
      {branch.error && <div className="mt-2 text-[12px]" style={{ color: 'var(--red)' }}>{branch.error}</div>}
      {open && ready && branch.running && (
        <div className="mt-2 text-[12px]"><MigrationDrift project={project} branch={branch.project} /></div>
      )}
    </div>
  );
}

/**
 * Preview branches of the current project.
 *
 * Opened on a branch, the page shows the same family (the console answers
 * for the parent), and creating from there still cuts from production.
 */
export default function Branches() {
  const id = useProjectId();
  const router = useRouter();
  const { enabled, query, branches, create, remove, act } = useBranches(id);
  const parent = branches[0]?.project;
  const [name, setName] = useState('');
  const [gitBranch, setGitBranch] = useState('');
  const [withData, setWithData] = useState(false);

  const submit = () => {
    if (!name.trim() || !parent) return;
    create.mutate({ name: name.trim(), gitBranch: gitBranch.trim() || undefined, withData });
    setName('');
    setGitBranch('');
  };

  const confirmAction = async (branch: Branch, action: 'merge' | 'rebase' | 'reset' | 'pause' | 'unpause') => {
    const copy = {
      merge: [`Merge ${branch.name} into production?`, "Its new migrations are applied to the production database, in order. They cannot be un-merged from here."],
      reset: [`Reset ${branch.name}?`, 'The branch is destroyed and cut again from production. Everything done on it is lost.'],
    } as const;
    const ask = copy[action as keyof typeof copy];
    if (ask && !(await confirmDialog({ title: ask[0], description: ask[1], confirmLabel: action === 'merge' ? 'Merge' : 'Reset', tone: 'danger' }))) return;
    act.mutate({ branch: branch.project, action });
  };

  const confirmDelete = async (branch: Branch) => {
    if (await confirmDialog({
      title: `Delete ${branch.name}?`,
      description: 'Its stack, database and storage are destroyed. Production is not touched.',
      confirmLabel: 'Delete branch',
      tone: 'danger',
      typeToConfirm: branch.name,
    })) remove.mutate(branch.project);
  };

  return (
    <PageShell>
      <PageHeader
        size="md"
        title="Branches"
        subtitle="Preview copies of this project, each with its own stack, database and URL. Test a change on a branch, then merge its migrations into production."
      />
      {!enabled ? (
        <EmptyState size="md" mascot="shield-keylock" title="Branches live on the Platform Console"
          description="Open this project from the Console to create and manage its branches." />
      ) : (
        <>
          <Note>
            A branch starts from production&apos;s <strong>migration history</strong> (Database, Migrations), the way
            Supabase branches do: tables created outside a migration are not copied. Tick <strong>Include data</strong> to
            clone the whole database instead. Merging applies the branch&apos;s new migrations to production, and is
            refused while production has migrations the branch lacks: rebase first.
          </Note>
          <Section title="Branches" flush bodyClassName="divide-y">
            {query.isLoading ? (
              <div className="space-y-3 px-5 py-4"><Skeleton style={{ height: 16, width: '60%' }} /><Skeleton style={{ height: 16, width: '40%' }} /></div>
            ) : query.error ? (
              <div className="px-5 py-4"><QueryFailure title="Could not load branches" error={query.error} onRetry={() => void query.refetch()} /></div>
            ) : (
              <div>
                {branches.map(branch => (
                  <BranchRow key={branch.project} project={parent ?? id!} branch={branch} busy={act.isPending || remove.isPending}
                    onAction={action => void confirmAction(branch, action)} onDelete={() => void confirmDelete(branch)}
                    onOpen={() => router.push(`/p/${encodeURIComponent(branch.project)}/overview`)} />
                ))}
                {branches.length === 1 && (
                  <div className="px-5 py-6"><EmptyState title="No branches yet" description="Create one below." /></div>
                )}
              </div>
            )}
          </Section>
          <Section title="Create a branch" description="Provisioning a stack takes a few minutes; the list updates on its own.">
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <Field label="Name" hint="Becomes part of the branch's URL.">
                <input className="input w-full" value={name} placeholder="feature-login" onChange={e => setName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && submit()} />
              </Field>
              <Field label="Git branch" hint="Optional, for reference.">
                <input className="input w-full" value={gitBranch} placeholder="feature/login" onChange={e => setGitBranch(e.target.value)} />
              </Field>
              <WriteButton capability="project.create" className="btn btn-primary" disabled={!name.trim() || !parent || create.isPending} onClick={submit}>
                <Plus size={13} /> Create branch
              </WriteButton>
            </div>
            <Checkbox className="mt-3" checked={withData} onChange={setWithData}
              label="Include data: copy production's rows too (users included), not only its schema" />
          </Section>
        </>
      )}
    </PageShell>
  );
}
