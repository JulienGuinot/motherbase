import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import type { Draft } from '@/features/database/types';
import { Field } from '@/shared/ui/Field';

export function NewMigrationModal({ draft, saving, onChange, onClose, onSave }: {
  draft: Draft;
  saving: boolean;
  onChange: (d: Draft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const canSave = draft.name.trim().length > 0 && draft.upSql.trim().length > 0;
  return (
    <Modal onClose={onClose} width="720px">
      <ModalHeader title="Create migration" />
      <ModalBody className="space-y-4">
        <Field label="Name">
          <input
            value={draft.name}
            onChange={e => onChange({ ...draft, name: e.target.value })}
            placeholder="e.g. add_posts_slug"
            className="input mono w-full"
            autoFocus
          />
        </Field>
        <Field label="Up SQL">
          <textarea
            value={draft.upSql}
            onChange={e => onChange({ ...draft, upSql: e.target.value })}
            placeholder="ALTER TABLE posts ADD COLUMN slug text;"
            rows={7}
            className="input mono w-full resize-y"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
          />
        </Field>
        <Field label="Down SQL" hint="Optional. Enables rollback.">
          <textarea
            value={draft.downSql}
            onChange={e => onChange({ ...draft, downSql: e.target.value })}
            placeholder="ALTER TABLE posts DROP COLUMN slug;"
            rows={5}
            className="input mono w-full resize-y"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
          />
        </Field>
      </ModalBody>
      <ModalFooter>
        <button onClick={onClose} className="btn">Cancel</button>
        <button onClick={onSave} disabled={!canSave || saving} className="btn btn-primary">
          {saving ? 'Saving…' : 'Create migration'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
