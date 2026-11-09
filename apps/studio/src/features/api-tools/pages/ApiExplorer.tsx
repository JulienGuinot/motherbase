'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyState } from '@/shared/ui/EmptyState';
import { PageShell, WorkbenchShell } from '@/shared/ui/PageHeader';
import { Note } from '@/shared/ui/Row';
import SettingsForm from '@/shared/ui/SettingsForm';
import { ListInput } from '@/shared/ui/ListInput';
import { functionNameError, joinList, splitList } from '@/shared/lib/list-values';
import type { FieldRenderer } from '@/shared/ui/SettingsFields';
import { Tabs } from '@/shared/ui/Tabs';
import { useContextMenu } from '@/shared/hooks/useContextMenu';
import { projectPath } from '@/shared/lib/project';
import { useApiExplorer } from '@/features/api-tools/hooks/useApiExplorer';
import { EndpointContextMenu } from '@/features/api-tools/components/EndpointContextMenu';
import { EndpointGroupList } from '@/features/api-tools/components/EndpointGroupList';
import { EndpointList } from '@/features/api-tools/components/EndpointList';
import { RequestPanel } from '@/features/api-tools/components/RequestPanel';
import type { Endpoint } from '@/features/api-tools/lib/endpoints';

const TABS = [
  { id: 'explorer', label: 'Explorer' },
  { id: 'settings', label: 'Settings' },
] as const;

// The exposed-RPC allowlist is one comma-separated string on the wire; edit it
// as chips. Validation mirrors the server's `functionNameList` superRefine, so
// what Studio flags is exactly what the save round-trip would reject.
const renderApiRestField: FieldRenderer = ({ field, values, setField, editable }) =>
  field.key === 'rpcSecurityDefiner' ? (
    <ListInput
      id="api-rest-rpc-security-definer"
      mono
      disabled={!editable}
      value={splitList(String(values.rpcSecurityDefiner ?? ''))}
      placeholder="rpc_search"
      validate={functionNameError}
      onChange={names => setField('rpcSecurityDefiner', joinList(names))}
    />
  ) : undefined;

type TabId = (typeof TABS)[number]['id'];

/*
 * The catalogue comes from `GET /admin/rest/resources`, which is the REST
 * router's own view of what it serves: `public` base tables, minus the blocked
 * ones, with their real primary keys.
 *
 * It used to be rebuilt from the Studio table list for whatever schema the
 * global picker had selected, minus a hand-written blacklist of six names. So
 * selecting `auth` or `storage` advertised `/rest/v1/<table>` routes the server
 * refuses by design, the blacklist never covered the auth/storage/platform
 * tables, and every PATCH and DELETE was documented with `id=eq.:id` even for a
 * table keyed on something else.
 */

function Explorer() {
  const router = useRouter();
  const menu = useContextMenu<Endpoint>();
  const explorer = useApiExplorer();
  const manageRls = () => router.push(projectPath('/auth/policies'));

  return (
    <WorkbenchShell>
      <EndpointGroupList
        groups={explorer.groups}
        selected={explorer.group}
        total={explorer.endpoints.length}
        isLoading={explorer.loadingTables}
        onSelect={explorer.selectGroup}
      />

      {!explorer.group ? (
        <EmptyState
          className="flex-1"
          mascot="coding"
          title="Select a model"
          description={`${explorer.groups.length} models available`}
        />
      ) : (
        <>
          <EndpointList
            group={explorer.group}
            endpoints={explorer.groupEndpoints}
            selected={explorer.endpoint}
            onSelect={explorer.selectEndpoint}
            onContextMenu={menu.onContextMenu}
          />

          {explorer.endpoint ? (
            <RequestPanel
              endpoint={explorer.endpoint}
              path={explorer.path}
              onPathChange={explorer.setPath}
              body={explorer.body}
              onBodyChange={explorer.setBody}
              onSend={explorer.send}
              sending={explorer.sending}
              status={explorer.status}
              failed={explorer.failed}
              response={explorer.response}
              rlsTable={explorer.rlsTable}
              onManageRls={manageRls}
            />
          ) : (
            <EmptyState className="flex-1" mascot="plug-cable" title="Select a route to explore" />
          )}
        </>
      )}

      {menu.menu && (
        <EndpointContextMenu
          x={menu.menu.x}
          y={menu.menu.y}
          endpoint={menu.menu.data}
          onClose={menu.close}
          onLoad={explorer.selectEndpoint}
          onManageRls={manageRls}
        />
      )}
    </WorkbenchShell>
  );
}

export default function ApiExplorer() {
  const [view, setView] = useState<TabId>('explorer');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Tabs className="px-1" items={TABS} value={view} onChange={setView} />

      {view === 'explorer' ? (
        <Explorer />
      ) : (
        <PageShell>
          <Note>
            Cap the number of rows a single REST GET can return. The query parser also enforces a hard ceiling of 1000.
            Changes apply on the next request.
          </Note>
          <SettingsForm group="api.rest" renderField={renderApiRestField} />
        </PageShell>
      )}
    </div>
  );
}
