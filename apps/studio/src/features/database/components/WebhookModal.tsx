'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import Select from '@/shared/ui/Select';
import { Field } from '@/shared/ui/Field';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { WriteButton } from '@/shared/ui/WriteButton';
import { AUTH_EVENT_ACTIONS, AUTH_EVENT_MODEL, ROW_EVENT_ACTIONS, eventModelName, formatEventSpec } from '@/shared/lib/event-utils';
import { webhookDraftIsComplete, type WebhookDraft } from '@/features/database/hooks/useWebhookAdmin';
import { useSystemEvents } from '@/features/database/hooks/useWebhooks';
import type { SystemEventSpec } from '@/features/database/api/webhooks.api';

interface EventTable {
  model: string;
}

/** Table plus operation, combined into one event spec such as `user.created`. */
function EventPicker({
  eventTables,
  loadingTables,
  systemEvents,
  onAdd,
}: {
  eventTables: EventTable[];
  loadingTables: boolean;
  /** Non-row events the server publishes, read from it rather than listed here. */
  systemEvents: SystemEventSpec[];
  onAdd: (spec: string) => void;
}) {
  const [table, setTable] = useState('*');
  const [action, setAction] = useState('*');
  const isAuth = table === AUTH_EVENT_MODEL;

  return (
    <>
      <div className="grid gap-2 sm:grid-cols-[1fr_150px_auto]">
        <Select
          value={table}
          onChange={v => { setTable(v); setAction('*'); }}
          ariaLabel="Table"
          style={{ minWidth: 150 }}
          options={[
            { value: '*', label: 'All tables' },
            { value: AUTH_EVENT_MODEL, label: 'Auth events' },
            ...eventTables.map(t => ({ value: eventModelName(t.model), label: t.model })),
          ]}
        />
        <Select
          value={action}
          onChange={setAction}
          ariaLabel="Operation"
          style={{ minWidth: 140 }}
          options={[
            { value: '*', label: isAuth ? 'All auth events' : 'All operations' },
            ...(isAuth ? AUTH_EVENT_ACTIONS : ROW_EVENT_ACTIONS).map(a => ({ value: a, label: a })),
          ]}
        />
        <button onClick={() => onAdd(table === '*' && action === '*' ? '*' : `${table}.${action}`)} className="btn" type="button">
          Add
        </button>
      </div>
      {loadingTables && (
        <div className="mt-2 text-[11px]" style={{ color: 'var(--text-mute)' }}>
          Loading tables…
        </div>
      )}

      {/* Events that are not row changes and not auth flows. `job_alert.created`
          is published by the server and had no entry here at all, so the only
          way to subscribe to it from this screen was a wildcard. */}
      {systemEvents.filter(event => !event.spec.startsWith('auth.')).length > 0 && (
        <div className="mt-3 space-y-1.5">
          <div className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
            Server events
          </div>
          <div className="flex flex-wrap gap-2">
            {systemEvents
              .filter(event => !event.spec.startsWith('auth.'))
              .map(event => (
                <button
                  key={event.spec}
                  type="button"
                  onClick={() => onAdd(event.spec)}
                  className="chip"
                  title={event.description}
                >
                  {event.label}
                </button>
              ))}
          </div>
        </div>
      )}
    </>
  );
}

export function WebhookModal({
  draft,
  onChange,
  onClose,
  onSave,
  saving,
  eventTables,
  loadingTables,
}: {
  draft: WebhookDraft;
  onChange: (draft: WebhookDraft) => void;
  onClose: () => void;
  onSave: () => void;
  saving: boolean;
  eventTables: EventTable[];
  loadingTables: boolean;
}) {
  const systemEventsQuery = useSystemEvents();
  const addEvent = (spec: string) => {
    if (draft.events.includes(spec)) return;
    onChange({ ...draft, events: [...draft.events, spec] });
  };

  return (
    <Modal onClose={onClose} width="560px">
      <ModalHeader title={draft.id ? 'Edit webhook' : 'Create webhook'} />

      <ModalBody className="space-y-4">
        <Field label="Name">
          <input
            value={draft.name}
            onChange={e => onChange({ ...draft, name: e.target.value })}
            placeholder="e.g. Slack #ops"
            className="input"
          />
        </Field>

        <Field label="URL">
          <input
            value={draft.url}
            onChange={e => onChange({ ...draft, url: e.target.value })}
            placeholder="https://hooks.example.com/..."
            className="input mono"
          />
        </Field>

        <Field label="Events">
          <EventPicker
            eventTables={eventTables}
            loadingTables={loadingTables}
            systemEvents={systemEventsQuery.data ?? []}
            onAdd={addEvent}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {draft.events.map(event => (
              <button
                key={event}
                type="button"
                onClick={() => onChange({ ...draft, events: draft.events.filter(x => x !== event) })}
                className="chip"
                title="Remove event"
              >
                {formatEventSpec(event, eventTables)}
                <X size={10} />
              </button>
            ))}
          </div>
        </Field>
      </ModalBody>

      <ModalFooter>
        <button onClick={onClose} className="btn">
          Cancel
        </button>
        <WriteButton
          capability="settings.write"
          onClick={onSave}
          className="btn btn-primary"
          disabled={!webhookDraftIsComplete(draft) || saving}
        >
          {saving ? 'Saving…' : draft.id ? 'Save' : 'Create'}
        </WriteButton>
      </ModalFooter>
    </Modal>
  );
}
