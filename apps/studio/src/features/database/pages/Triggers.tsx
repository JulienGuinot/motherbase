'use client';

import Link from 'next/link';
import { Code2, Plus } from 'lucide-react';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { WriteButton } from '@/shared/ui/WriteButton';
import { useContextMenu } from '@/shared/hooks/useContextMenu';
import { useSchema } from '@/shared/lib/schema';
import { projectPath } from '@/shared/lib/project';
import { useTriggerFunctions, useTriggerTables, useTriggers } from '@/features/database/hooks/useTriggers';
import { useTriggerAdmin } from '@/features/database/hooks/useTriggerAdmin';
import { TriggerContextMenu } from '@/features/database/components/TriggerContextMenu';
import dynamic from 'next/dynamic';

// A CodeMirror editor behind a modal: nothing to load until it opens.
const TriggerEditorModal = dynamic(
  () => import('@/features/database/components/TriggerEditorModal').then(m => m.TriggerEditorModal),
  { ssr: false },
);
import { TriggerList } from '@/features/database/components/TriggerList';
import type { TriggerInfo } from '@/features/database/types';

/** A trigger has nothing to call until a function RETURNS trigger exists. */
function NoTriggerFunctionsNotice() {
  return (
    <div className="card flex items-center gap-3 p-4 text-[12px]" style={{ color: 'var(--paper-mute)' }}>
      <Code2 size={14} />
      <span>
        Triggers need a function that <span className="mono">RETURNS trigger</span>. Create one on the{' '}
        <Link href={projectPath('/database/functions')} className="underline" style={{ color: 'var(--accent)' }}>
          Functions
        </Link>{' '}
        page first.
      </span>
    </div>
  );
}

export default function Triggers() {
  const menu = useContextMenu<TriggerInfo>();
  const { schema } = useSchema();

  const triggersQuery = useTriggers(schema);
  const tablesQuery = useTriggerTables(schema);
  const functionsQuery = useTriggerFunctions(schema);
  const triggers = useTriggerAdmin(schema);

  const tables = tablesQuery.data ?? [];
  const functions = functionsQuery.data ?? [];
  const hasTriggerFunctions = functions.length > 0;

  return (
    <>
      <PageShell width="wide">
        <PageHeader
          title="Postgres triggers"
          subtitle="Real PostgreSQL triggers that run a trigger function when rows change."
          actions={
            <WriteButton
              onClick={() => triggers.startCreate(tables[0]?.name ?? '')}
              className="btn btn-primary"
              disabled={tablesQuery.isLoading || !hasTriggerFunctions}
              title={hasTriggerFunctions ? undefined : 'Create a function that RETURNS trigger first'}
            >
              <Plus size={12} /> New
            </WriteButton>
          }
        />

        {!hasTriggerFunctions && !functionsQuery.isLoading && <NoTriggerFunctionsNotice />}

        <TriggerList
          triggers={triggersQuery.data ?? []}
          isLoading={triggersQuery.isLoading}
          onToggle={triggers.toggle}
          onEdit={triggers.startEdit}
          onDrop={triggers.confirmDrop}
          onContextMenu={menu.onContextMenu}
        />
      </PageShell>

      {menu.menu && (
        <TriggerContextMenu
          x={menu.menu.x}
          y={menu.menu.y}
          trigger={menu.menu.data}
          onClose={menu.close}
          onEdit={triggers.startEdit}
          onToggle={triggers.toggle}
          onDrop={triggers.confirmDrop}
        />
      )}

      {triggers.draft && (
        <TriggerEditorModal
          draft={triggers.draft}
          schema={schema}
          tables={tables}
          functions={functions}
          saving={triggers.saving}
          onChange={triggers.setDraft}
          onSave={triggers.save}
          onClose={() => triggers.setDraft(null)}
        />
      )}
    </>
  );
}
