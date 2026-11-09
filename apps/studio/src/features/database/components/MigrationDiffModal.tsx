import { Info, Wand2 } from 'lucide-react';
import { CodeBlock } from '@/shared/ui/CodeBlock';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import type { DiffResult } from '@/features/database/types';
import { EmptyState } from '@/shared/ui/EmptyState';
import { Labeled } from '@/shared/ui/Field';

export function DiffModal({ diff, onClose, onCreate }: {
  diff: DiffResult;
  onClose: () => void;
  onCreate: () => void;
}) {
  const hasSql = diff.suggestedSql.trim().length > 0;
  return (
    <Modal onClose={onClose} width="720px">
      <ModalHeader title="Schema diff" />
      <ModalBody className="space-y-4">
        <div className="card flex items-start gap-3 p-3" style={{ background: 'var(--surface-2)' }}>
          <Info size={16} style={{ color: 'var(--blue)', flexShrink: 0, marginTop: 1 }} />
          <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
            The live schema is compared against the last snapshot. The suggested SQL below is a best-effort
            starting point: review and edit it before saving as a migration.
          </p>
        </div>

        {diff.diff.trim() && (
          <Labeled label="Changes">
            <CodeBlock value={diff.diff.trim()} label="Diff" language="diff" maxHeight={260} />
          </Labeled>
        )}

        <Labeled label="Suggested SQL">
          {hasSql ? (
            <CodeBlock value={diff.suggestedSql} label="SQL" language="sql" maxHeight={320} />
          ) : (
            <EmptyState className="card" mascot="success" title="Schema is in sync" description="The live schema matches the last snapshot. Nothing to migrate." />
          )}
        </Labeled>
      </ModalBody>
      <ModalFooter>
        <button onClick={onClose} className="btn">Close</button>
        <button onClick={onCreate} disabled={!hasSql} className="btn btn-primary">
          <Wand2 size={12} /> Create migration from this
        </button>
      </ModalFooter>
    </Modal>
  );
}
