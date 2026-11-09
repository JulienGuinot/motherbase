import { Play, RotateCcw } from 'lucide-react';
import { CodeBlock } from '@/shared/ui/CodeBlock';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { OriginBadge, StatusBadge } from '@/features/database/components/MigrationStatusBadge';
import { useMigrationDetail } from '@/features/database/hooks/useMigrations';
import { Labeled } from '@/shared/ui/Field';
import { SkeletonList } from '@/shared/ui/Skeleton';

export function DetailModal({ id, onClose, onApply, onRollback }: {
  id: string;
  onClose: () => void;
  onApply: (id: string) => void;
  onRollback: (id: string) => void;
}) {
  const detailQ = useMigrationDetail(id);

  const m = detailQ.data;

  return (
    <Modal onClose={onClose} width="720px">
      <ModalHeader title={m?.name ?? 'Migration'} />
      <ModalBody className="space-y-4">
        {detailQ.isLoading || !m ? (
          <SkeletonList rows={4} height={40} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge status={m.status} />
              <OriginBadge origin={m.origin} />
              <span className="mono text-[12px]">{m.version}</span>
              <span className="mono text-[11px]" style={{ color: 'var(--text-mute)' }}>{m.checksum}</span>
              <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                {m.status === 'applied' && m.appliedAt
                  ? `applied ${new Date(m.appliedAt).toLocaleString()}`
                  : `created ${new Date(m.createdAt).toLocaleString()}`}
              </span>
            </div>

            <Labeled label="Up SQL">
              <CodeBlock value={m.upSql} label="SQL" language="sql" maxHeight={320} />
            </Labeled>

            <Labeled label="Down SQL">
              {m.downSql?.trim() ? (
                <CodeBlock value={m.downSql} label="SQL" language="sql" maxHeight={320} />
              ) : (
                <p className="rounded p-3 text-[12px]" style={{ background: 'var(--surface-2)', color: 'var(--text-mute)' }}>
                  No down SQL: this migration cannot be rolled back.
                </p>
              )}
            </Labeled>
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <button onClick={onClose} className="btn">Close</button>
        <button
          onClick={() => onApply(id)}
          disabled={!m || m.status === 'applied'}
          className="btn"
        >
          <Play size={12} /> Apply
        </button>
        <button
          onClick={() => onRollback(id)}
          disabled={!m || m.status !== 'applied' || !m.downSql?.trim()}
          className="btn"
          style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
        >
          <RotateCcw size={12} /> Roll back
        </button>
      </ModalFooter>
    </Modal>
  );
}
