'use client';

import { useState } from 'react';
import { GitCompare, Plus } from 'lucide-react';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { WriteButton } from '@/shared/ui/WriteButton';
import { useMigrations } from '@/features/database/hooks/useMigrations';
import { useMigrationAdmin } from '@/features/database/hooks/useMigrationAdmin';
import { GitRepoCard } from '@/features/database/components/GitRepoCard';
import { MigrationList } from '@/features/database/components/MigrationList';
import { NewMigrationModal } from '@/features/database/components/NewMigrationModal';
import dynamic from 'next/dynamic';

// Diff rendering behind a modal: nothing to load until it opens.
const DiffModal = dynamic(
  () => import('@/features/database/components/MigrationDiffModal').then(m => m.DiffModal),
  { ssr: false },
);
import { DetailModal } from '@/features/database/components/MigrationDetailModal';

export default function Migrations() {
  const [detailId, setDetailId] = useState<string | null>(null);
  const listQuery = useMigrations();
  const migrations = useMigrationAdmin();

  const applyFromDetail = (id: string) => {
    migrations.confirmApply(id);
    setDetailId(null);
  };

  const rollbackFromDetail = (id: string) => {
    migrations.confirmRollback(id);
    setDetailId(null);
  };

  return (
    <>
      <PageShell width="wide">
        <PageHeader
          title="Migrations"
          subtitle="Version your schema with reviewable up/down SQL: apply, roll back, and diff against the live database. The CLI (motherbase migration list) reads the same history."
          actions={
            <>
              <button onClick={migrations.runDiff} disabled={migrations.diffing} className="btn">
                <GitCompare size={12} /> {migrations.diffing ? 'Diffing…' : 'Diff from live'}
              </button>
              <WriteButton onClick={migrations.startNew} className="btn btn-primary">
                <Plus size={12} /> New migration
              </WriteButton>
            </>
          }
        />

        <GitRepoCard />

        <MigrationList
          migrations={listQuery.data ?? []}
          isLoading={listQuery.isLoading}
          onOpen={setDetailId}
          onApply={migrations.confirmApply}
          onRollback={migrations.confirmRollback}
          onRepair={migrations.confirmRepair}
          onNew={migrations.startNew}
          onDiff={migrations.runDiff}
          applying={migrations.applying}
          rollingBack={migrations.rollingBack}
          repairing={migrations.repairing}
          diffing={migrations.diffing}
        />
      </PageShell>

      {migrations.draft && (
        <NewMigrationModal
          draft={migrations.draft}
          saving={migrations.creating}
          onChange={migrations.setDraft}
          onClose={() => migrations.setDraft(null)}
          onSave={() => migrations.draft && migrations.create(migrations.draft)}
        />
      )}

      {migrations.diff && (
        <DiffModal
          diff={migrations.diff}
          onClose={migrations.clearDiff}
          onCreate={() => migrations.diff && migrations.startFromDiff(migrations.diff.suggestedSql)}
        />
      )}

      {detailId && (
        <DetailModal
          id={detailId}
          onClose={() => setDetailId(null)}
          onApply={applyFromDetail}
          onRollback={rollbackFromDetail}
        />
      )}
    </>
  );
}
