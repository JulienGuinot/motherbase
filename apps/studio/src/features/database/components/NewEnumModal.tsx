import { useState } from 'react';
import { Field } from '@/shared/ui/Field';
import { ListInput } from '@/shared/ui/ListInput';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';

/** Shared by Database › Enumerated Types and the column-type picker. */
export function NewEnumModal({
  saving,
  onSave,
  onClose,
}: {
  saving: boolean;
  onSave: (name: string, values: string[]) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [values, setValues] = useState<string[]>([]);
  const duplicate = values.find((value, index) => values.indexOf(value) !== index);

  return (
    <Modal onClose={onClose}>
      <ModalHeader title="New enumerated type" description="A column of this type accepts only these values, in this order." />
      <ModalBody className="space-y-4">
        <Field label="Name">
          <input className="input mono w-full" value={name} placeholder="order_status" onChange={event => setName(event.target.value)} autoFocus />
        </Field>
        <Field label="Values" htmlFor="enum-values" error={duplicate ? `"${duplicate}" is listed twice` : undefined}>
          <ListInput id="enum-values" mono value={values} onChange={setValues} placeholder="pending, paid, shipped" />
        </Field>
      </ModalBody>
      <ModalFooter>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || !name.trim() || !values.length || Boolean(duplicate)}
          onClick={() => onSave(name.trim(), values)}
        >
          Create type
        </button>
      </ModalFooter>
    </Modal>
  );
}
