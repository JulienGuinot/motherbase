'use client';

import { WorkbenchShell } from '@/shared/ui/PageHeader';
import { useContextMenu } from '@/shared/hooks/useContextMenu';
import { useSchema } from '@/shared/lib/schema';
import { useFunctions } from '@/features/database/hooks/useFunctions';
import { useFunctionEditor } from '@/features/database/hooks/useFunctionEditor';
import { FunctionContextMenu } from '@/features/database/components/FunctionContextMenu';
import { FunctionEditorPane } from '@/features/database/components/FunctionEditorPane';
import { FunctionSidebar } from '@/features/database/components/FunctionSidebar';
import type { FnInfo } from '@/features/database/types';

export default function Functions() {
  const menu = useContextMenu<FnInfo>();
  const { schema } = useSchema();
  const functionsQuery = useFunctions(schema);
  const editor = useFunctionEditor();

  return (
    <WorkbenchShell>
      <FunctionSidebar
        functions={functionsQuery.data ?? []}
        isLoading={functionsQuery.isLoading}
        selected={editor.isNew ? null : editor.selected}
        onSelect={editor.open}
        onNew={editor.startNew}
        onContextMenu={menu.onContextMenu}
      />

      <FunctionEditorPane
        selected={editor.selected}
        isNew={editor.isNew}
        code={editor.code}
        onChange={editor.setCode}
        onSave={editor.save}
        saving={editor.saving}
        onDrop={editor.confirmDrop}
        dropping={editor.dropping}
      />

      {menu.menu && (
        <FunctionContextMenu
          x={menu.menu.x}
          y={menu.menu.y}
          fn={menu.menu.data}
          onClose={menu.close}
          onOpen={editor.open}
          onDrop={editor.confirmDrop}
        />
      )}
    </WorkbenchShell>
  );
}
