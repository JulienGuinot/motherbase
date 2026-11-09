import { useState } from 'react';
import { RotateCcw, AlertTriangle } from 'lucide-react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import type { RestoreTarget } from '@/features/database/types';
import { Field } from '@/shared/ui/Field';

export function RestoreModal({ target, pending, onClose, onConfirm }: {
  target: RestoreTarget;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [text, setText] = useState('');
  const armed = text === 'RESTORE';

  return (
    <Modal onClose={onClose} width="520px">
      <ModalHeader title="Restore from backup" />
      <ModalBody className="space-y-4">
        <div className="card flex items-start gap-3 p-3" style={{ background: 'var(--surface-2)' }}>
          <AlertTriangle size={16} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 1 }} />
          <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
            This will overwrite the current database with the contents of this backup. Existing data not in
            the snapshot will be lost. This cannot be undone.
          </p>
        </div>
        <Field label="Backup">
          <div className="mono break-all rounded p-2 text-[11px]" style={{ background: 'var(--surface-2)', color: 'var(--text-dim)' }}>
            {target.name}
          </div>
        </Field>
        <div>
          <div className="label mb-1">
            Type <span className="mono" style={{ color: 'var(--text)' }}>RESTORE</span> to confirm
          </div>
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="RESTORE"
            className="input mono"
            autoFocus
          />
        </div>
      </ModalBody>
      <ModalFooter>
        <button onClick={onClose} className="btn">Cancel</button>
        <button
          onClick={onConfirm}
          disabled={!armed || pending}
          className="btn btn-primary"
          style={armed ? { background: 'var(--danger)', borderColor: 'var(--danger)' } : undefined}
        >
          <RotateCcw size={12} /> {pending ? 'Restoring…' : 'Restore'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
