'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { WriteButton } from '@/shared/ui/WriteButton';
import { SYSTEM_SCHEMAS, useSchema } from '@/shared/lib/schema';
import { projectPath } from '@/shared/lib/project';
import NewTableModal from '@/features/tables/components/NewTableModal';

/**
 * "New table" for the pages outside the Table Editor that list the schema's
 * tables. The table opens in the editor once created, as it does from the
 * editor's own sidebar. Absent on the system schemas, which the editor treats
 * as read-only.
 */
export function NewTableButton() {
  const router = useRouter();
  const { schema } = useSchema();
  const [open, setOpen] = useState(false);

  if (SYSTEM_SCHEMAS.has(schema)) return null;

  return (
    <>
      <WriteButton className="btn btn-primary" onClick={() => setOpen(true)}>
        <Plus size={12} /> New table
      </WriteButton>
      {open && (
        <NewTableModal
          onClose={() => setOpen(false)}
          onCreated={name => router.push(projectPath(`/tables/${encodeURIComponent(name)}`))}
        />
      )}
    </>
  );
}
