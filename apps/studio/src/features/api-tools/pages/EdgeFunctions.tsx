'use client';

import { WorkbenchShell } from '@/shared/ui/PageHeader';
import { useContextMenu } from '@/shared/hooks/useContextMenu';
import { useEdgeFunctionEditor } from '@/features/api-tools/hooks/useEdgeFunctionEditor';
import { EdgeFunctionContextMenu } from '@/features/api-tools/components/EdgeFunctionContextMenu';
import { EdgeFunctionSecretsPanel } from '@/features/api-tools/components/EdgeFunctionSecretsPanel';
import { EdgeFunctionSidebar } from '@/features/api-tools/components/EdgeFunctionSidebar';
import { EdgeFunctionWorkspace } from '@/features/api-tools/components/EdgeFunctionWorkspace';
import type { EdgeFn } from '@/features/api-tools/types';

export default function EdgeFunctions() {
  const editor = useEdgeFunctionEditor();
  const menu = useContextMenu<EdgeFn>();

  return (
    <WorkbenchShell>
      <EdgeFunctionSidebar
        functions={editor.functions}
        isLoading={editor.listLoading}
        selectedId={editor.isNew ? undefined : editor.selected?.id}
        secretsOpen={editor.showSecrets}
        onOpen={fn => editor.open(fn)}
        onNew={editor.startNew}
        onOpenSecrets={editor.openSecrets}
        onContextMenu={menu.onContextMenu}
      />

      {editor.showSecrets ? (
        <EdgeFunctionSecretsPanel
          secrets={editor.secrets}
          secretName={editor.secretName}
          secretValue={editor.secretValue}
          saving={editor.savingSecret}
          onNameChange={editor.setSecretName}
          onValueChange={editor.setSecretValue}
          onSave={editor.saveSecret}
          onDelete={editor.deleteSecret}
        />
      ) : editor.selected || editor.isNew ? (
        <EdgeFunctionWorkspace
          selected={editor.selected}
          isNew={editor.isNew}
          newName={editor.name}
          newRoute={editor.route}
          schedule={editor.schedule}
          code={editor.code}
          activeTab={editor.tab}
          invokeBody={editor.invokeBody}
          invokeResult={editor.invokeResult}
          logs={editor.logs}
          logsLoading={editor.logsLoading}
          creating={editor.creating}
          saving={editor.saving}
          deleting={editor.deleting}
          invoking={editor.invoking}
          togglingPublic={editor.togglingPublic}
          onNewNameChange={editor.setName}
          onNewRouteChange={editor.setRoute}
          onScheduleChange={editor.setSchedule}
          onCodeChange={editor.setCode}
          onTabChange={editor.setTab}
          onInvokeBodyChange={editor.setInvokeBody}
          onCreate={editor.create}
          onSave={editor.save}
          onDelete={editor.deleteSelected}
          onInvoke={editor.invoke}
          onTogglePublic={editor.togglePublic}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--text-mute)' }}>
          <span className="text-[13px]">Select a function or create a new one</span>
        </div>
      )}

      {menu.menu && (
        <EdgeFunctionContextMenu
          x={menu.menu.x}
          y={menu.menu.y}
          fn={menu.menu.data}
          invokeUrl={editor.invokeUrl(menu.menu.data.route)}
          onClose={menu.close}
          onOpen={editor.open}
          onToggle={editor.toggleEnabled}
          onDelete={editor.confirmDelete}
        />
      )}
    </WorkbenchShell>
  );
}
