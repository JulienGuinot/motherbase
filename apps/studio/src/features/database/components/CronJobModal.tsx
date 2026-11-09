'use client';

import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { Field } from '@/shared/ui/Field';
import { WriteButton } from '@/shared/ui/WriteButton';
import { cronDraftIsComplete, type CronDraft } from '@/features/database/hooks/useCronAdmin';

export function CronJobModal({
  draft,
  onChange,
  onClose,
  onSave,
  saving,
}: {
  draft: CronDraft;
  onChange: (draft: CronDraft) => void;
  onClose: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <Modal onClose={onClose} width="560px">
      <ModalHeader title={draft.editing ? 'Edit cron job' : 'Create cron job'} />

      <ModalBody className="space-y-4">
        <Field label="Name">
          <input
            value={draft.name}
            onChange={e => onChange({ ...draft, name: e.target.value })}
            placeholder="e.g. nightly-cleanup"
            className="input mono"
          />
        </Field>

        <div>
          <div className="label mb-1">
            Schedule
            <span className="ml-2 font-normal" style={{ color: 'var(--text-mute)' }}>
              min · hr · day · month · weekday
            </span>
          </div>
          <input
            value={draft.schedule}
            onChange={e => onChange({ ...draft, schedule: e.target.value })}
            placeholder="0 3 * * *"
            className="input mono"
          />
        </div>

        <Field label="SQL command">
          <textarea
            value={draft.command}
            onChange={e => onChange({ ...draft, command: e.target.value })}
            placeholder="SELECT cleanup_expired_sessions();"
            rows={4}
            className="input mono w-full resize-y"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
          />
        </Field>
      </ModalBody>

      <ModalFooter>
        <button onClick={onClose} className="btn">
          Cancel
        </button>
        <WriteButton onClick={onSave} className="btn btn-primary" disabled={!cronDraftIsComplete(draft) || saving}>
          {saving ? 'Saving…' : draft.editing ? 'Save' : 'Create'}
        </WriteButton>
      </ModalFooter>
    </Modal>
  );
}
