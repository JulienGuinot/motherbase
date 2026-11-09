'use client';

import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { WriteButton } from '@/shared/ui/WriteButton';
import { useContextMenu } from '@/shared/hooks/useContextMenu';
import { isUserEventTable } from '@/shared/lib/event-utils';
import { useWebhooks, useWebhookTables } from '@/features/database/hooks/useWebhooks';
import { useWebhookAdmin } from '@/features/database/hooks/useWebhookAdmin';
import { WebhookContextMenu } from '@/features/database/components/WebhookContextMenu';
import { WebhookDrawer } from '@/features/database/components/WebhookDrawer';
import { WebhookList } from '@/features/database/components/WebhookList';
import { WebhookModal } from '@/features/database/components/WebhookModal';
import type { Hook } from '@/features/database/types';

export default function Webhooks() {
  const [selected, setSelected] = useState<Hook | null>(null);
  const menu = useContextMenu<Hook>();

  const hooksQuery = useWebhooks();
  const tablesQuery = useWebhookTables();
  const webhooks = useWebhookAdmin();

  const eventTables = useMemo(() => (tablesQuery.data ?? []).filter(isUserEventTable), [tablesQuery.data]);

  const edit = (hook: Hook) => {
    webhooks.startEdit(hook);
    setSelected(null);
  };

  const remove = (hook: Hook) => {
    webhooks.confirmRemove(hook);
    setSelected(null);
  };

  return (
    <>
      <PageShell width="wide">
        <PageHeader
          title="Outgoing events"
          subtitle="Define destinations for platform events, persist them server-side, and send a test payload before enabling automations."
          actions={
            <WriteButton capability="settings.write" onClick={webhooks.startCreate} className="btn btn-primary">
              <Plus size={12} /> New
            </WriteButton>
          }
        />

        <WebhookList
          hooks={hooksQuery.data ?? []}
          isLoading={hooksQuery.isLoading}
          eventTables={eventTables}
          testing={webhooks.testing}
          onOpen={setSelected}
          onEdit={edit}
          onToggle={webhooks.toggle}
          onTest={webhooks.test}
          onDelete={remove}
          onContextMenu={menu.onContextMenu}
        />
      </PageShell>

      {menu.menu && (
        <WebhookContextMenu
          x={menu.menu.x}
          y={menu.menu.y}
          hook={menu.menu.data}
          onClose={menu.close}
          onEdit={edit}
          onToggle={webhooks.toggle}
          onTest={webhooks.test}
          onDelete={remove}
        />
      )}

      {selected && (
        <WebhookDrawer
          hook={selected}
          eventTables={eventTables}
          onClose={() => setSelected(null)}
          onEdit={() => edit(selected)}
          onTest={() => webhooks.test(selected.id)}
          onToggle={() => webhooks.toggle(selected)}
          onDelete={() => remove(selected)}
        />
      )}

      {webhooks.draft && (
        <WebhookModal
          draft={webhooks.draft}
          onChange={webhooks.setDraft}
          onClose={() => webhooks.setDraft(null)}
          onSave={webhooks.save}
          saving={webhooks.saving}
          eventTables={eventTables}
          loadingTables={tablesQuery.isLoading}
        />
      )}
    </>
  );
}
