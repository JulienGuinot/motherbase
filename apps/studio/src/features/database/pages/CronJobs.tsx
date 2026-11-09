'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { Tabs } from '@/shared/ui/Tabs';
import { WriteButton } from '@/shared/ui/WriteButton';
import { useContextMenu } from '@/shared/hooks/useContextMenu';
import { useAppCronJobs, usePgCronJobs } from '@/features/database/hooks/useCron';
import { useCronAdmin } from '@/features/database/hooks/useCronAdmin';
import { AppJobPanel } from '@/features/database/components/AppJobPanel';
import { CronJobContextMenu } from '@/features/database/components/CronJobContextMenu';
import { CronJobModal } from '@/features/database/components/CronJobModal';
import { CronRunDrawer } from '@/features/database/components/CronRunDrawer';
import { PgCronPanel } from '@/features/database/components/PgCronPanel';
import type { PgCronJob } from '@/features/database/types';

const TABS = [
  { id: 'pg', label: 'pg_cron' },
  { id: 'app', label: 'App Jobs' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function CronJobs() {
  const [tab, setTab] = useState<TabId>('pg');
  const [history, setHistory] = useState<PgCronJob | null>(null);
  const menu = useContextMenu<PgCronJob>();

  const pgQuery = usePgCronJobs();
  const appQuery = useAppCronJobs(tab === 'app');
  const cron = useCronAdmin();

  const extensionMissing = pgQuery.data?.extensionMissing ?? false;

  return (
    <>
      <PageShell width="wide">
        <PageHeader
          title="Cron Jobs"
          subtitle="Schedule recurring tasks: Postgres-native (pg_cron) or application-level jobs."
          actions={
            tab === 'pg' && !extensionMissing ? (
              <WriteButton onClick={cron.startCreate} className="btn btn-primary">
                <Plus size={12} /> New job
              </WriteButton>
            ) : undefined
          }
        />

        <Tabs items={TABS} value={tab} onChange={setTab} />

        {tab === 'pg' ? (
          <PgCronPanel
            query={pgQuery}
            onEnableExtension={cron.enableExtension}
            enablingExtension={cron.enablingExtension}
            onCreate={cron.startCreate}
            onToggle={cron.toggle}
            onEdit={cron.startEdit}
            onDelete={cron.confirmRemove}
            onOpenHistory={setHistory}
            onContextMenu={menu.onContextMenu}
          />
        ) : (
          <AppJobPanel query={appQuery} />
        )}
      </PageShell>

      {menu.menu && (
        <CronJobContextMenu
          x={menu.menu.x}
          y={menu.menu.y}
          job={menu.menu.data}
          onClose={menu.close}
          onEdit={cron.startEdit}
          onToggle={cron.toggle}
          onDelete={cron.confirmRemove}
        />
      )}

      {cron.draft && (
        <CronJobModal
          draft={cron.draft}
          onChange={cron.setDraft}
          onClose={() => cron.setDraft(null)}
          onSave={cron.save}
          saving={cron.saving}
        />
      )}

      {history && <CronRunDrawer job={history} onClose={() => setHistory(null)} />}
    </>
  );
}
