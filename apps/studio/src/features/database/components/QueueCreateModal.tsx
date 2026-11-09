'use client';

import { useState } from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { Checkbox, Field } from '@/shared/ui/Field';
import Select from '@/shared/ui/Select';
import { WriteButton } from '@/shared/ui/WriteButton';
import type { QueueType } from '@/features/database/api/queues.api';

/** Mirrors QUEUE_NAME_RE on the server: what pgmq stores unchanged. */
export const QUEUE_NAME_RE = /^[a-z_][a-z0-9_]{0,46}$/;

const TYPE_HINTS: Record<QueueType, string> = {
  basic: 'A logged table: messages survive a crash and a restart.',
  unlogged: 'Faster writes, but messages are lost if Postgres crashes. For work that can be re-queued.',
  partitioned: 'Partitioned by message id with pg_partman, for very high volume.',
};

export function QueueCreateModal({
  partitionedAvailable,
  saving,
  onClose,
  onCreate,
}: {
  partitionedAvailable: boolean;
  saving: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; type: QueueType; rls: boolean }) => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<QueueType>('basic');
  const [rls, setRls] = useState(true);
  const invalid = name !== '' && !QUEUE_NAME_RE.test(name);

  return (
    <Modal onClose={onClose} width="520px">
      <ModalHeader title="Create queue" description="A pgmq queue: a table of messages plus an archive." />

      <ModalBody className="space-y-4">
        <Field
          label="Name"
          error={invalid ? 'Lowercase letters, digits and underscores, starting with a letter; 47 characters at most.' : undefined}
        >
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. email_jobs"
            className="input mono"
            autoFocus
          />
        </Field>

        <Field label="Type" hint={TYPE_HINTS[type]}>
          <Select
            value={type}
            onChange={value => setType(value as QueueType)}
            options={[
              { value: 'basic', label: 'Basic' },
              { value: 'unlogged', label: 'Unlogged' },
              {
                value: 'partitioned',
                label: partitionedAvailable ? 'Partitioned' : 'Partitioned (needs pg_partman)',
                disabled: !partitionedAvailable,
              },
            ]}
          />
        </Field>

        <div className="space-y-1">
          <Checkbox checked={rls} onChange={setRls} label="Enable row level security" />
          <p className="pl-6 text-[11px]" style={{ color: 'var(--text-mute)' }}>
            Recommended. With RLS on, roles you grant access to still only see the messages a policy on{' '}
            <span className="mono">pgmq.q_{name || '<name>'}</span> admits.
          </p>
        </div>
      </ModalBody>

      <ModalFooter>
        <button onClick={onClose} className="btn">
          Cancel
        </button>
        <WriteButton
          onClick={() => onCreate({ name, type, rls })}
          className="btn btn-primary"
          disabled={!QUEUE_NAME_RE.test(name) || saving}
        >
          {saving ? 'Creating…' : 'Create queue'}
        </WriteButton>
      </ModalFooter>
    </Modal>
  );
}
