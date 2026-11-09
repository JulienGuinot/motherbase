'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { SECRET_SENTINEL, sendTestEmail, sendTestSms, type MaskedSettings } from '@/shared/lib/settings';
import { useSettingsGroup } from '@/shared/hooks/useSettingsGroup';
import { useToast } from '@/shared/lib/toast';
import { requiredSettingsCapability, useProjectCapability } from '@/features/platform/hooks/usePlatformAccess';
import { SettingsAccessNotice } from '@/shared/ui/SettingsAccessNotice';
import SettingsFields, { type FieldRenderer } from '@/shared/ui/SettingsFields';
import { confirmDialog, promptDialog } from '@/shared/ui/ConfirmDialog';
import { Section } from '@/shared/ui/Section';
import { Skeleton } from '@/shared/ui/Skeleton';

/** Rendered under the group's action row, with the editor's live state. Used
 *  where an action has to act on what is on screen rather than on what is
 *  saved: the AI assistant's "Test connection" tests the key being typed. */
export type SettingsExtraRenderer = (ctx: {
  values: Record<string, unknown>;
  dirty: boolean;
  editable: boolean;
}) => ReactNode;

/** A delivery transport's "send me one" action, run against the saved settings. */
interface DeliveryTest {
  label: string;
  prompt: { title: string; description: string; placeholder: string; type: 'email' | 'tel' };
  send: (to: string) => Promise<{ ms: number }>;
}

const DELIVERY_TESTS: Record<string, DeliveryTest> = {
  'email.smtp': {
    label: 'Send test email',
    prompt: { title: 'Send a test email', description: 'Uses the saved SMTP settings.', placeholder: 'you@example.com', type: 'email' },
    send: sendTestEmail,
  },
  'phone.sms': {
    label: 'Send test SMS',
    prompt: { title: 'Send a test SMS', description: 'Uses the saved Twilio settings.', placeholder: '+15551234567', type: 'tel' },
    send: sendTestSms,
  },
};

export interface SettingsFormProps {
  group: string;
  /** Replaces the group's own description under the title. */
  description?: ReactNode;
  onSaved?: () => void;
  /** Replaces the generic control for a field. Return undefined to keep it.
   *  Used where a group needs live data the schema cannot describe. The AI
   *  model picker fetches its options from the provider. */
  renderField?: FieldRenderer;
  renderExtra?: SettingsExtraRenderer;
}

export default function SettingsForm({ group, description, onSaved, renderField, renderExtra }: SettingsFormProps) {
  const { query, save, reset } = useSettingsGroup(group);
  // Writes that landed. Counted after the mutation resolves, by which time its
  // response is already in the cache.
  const [writes, setWrites] = useState(0);

  if (query.isPending) {
    return <Skeleton className="rounded-lg" style={{ height: 220 }} />;
  }

  if (query.isError) {
    return (
      <div className="card p-5">
        <p className="text-[12px]" style={{ color: 'var(--danger)' }}>
          {getErrorMessage(query.error, 'These settings could not be loaded')}
        </p>
        <button className="btn mt-3" onClick={() => void query.refetch()}>Try again</button>
      </div>
    );
  }

  const data = query.data;
  // The editor's state is seeded from the loaded group, so it is re-keyed
  // rather than synced: a save or a reset returns fresh values and remounts
  // the form on them. A plain background refetch does not remount it, so it
  // can never wipe what the operator is halfway through typing.
  // Keyed on writes that succeeded, not on `submittedAt`: that changes when a
  // save starts, which would remount the form on the old values and show them
  // as saved.
  const version = `${data.group}:${data.source}:${writes}`;

  return (
    <GroupEditor
      key={version}
      data={data}
      description={description ?? data.description}
      deliveryTest={DELIVERY_TESTS[group]}
      renderField={renderField}
      renderExtra={renderExtra}
      saving={save.isPending}
      resetting={reset.isPending}
      onSave={async values => {
        await save.mutateAsync(values);
        setWrites(n => n + 1);
        onSaved?.();
      }}
      onReset={async () => {
        await reset.mutateAsync();
        setWrites(n => n + 1);
        onSaved?.();
      }}
    />
  );
}

/** Blank every secret: leaving one blank preserves the stored value. */
function initialValues(data: MaskedSettings): Record<string, unknown> {
  const values: Record<string, unknown> = { ...data.values };
  for (const field of data.fields) if (field.secret) values[field.key] = '';
  return values;
}

function GroupEditor({
  data,
  description,
  deliveryTest,
  renderField,
  renderExtra,
  saving,
  resetting,
  onSave,
  onReset,
}: {
  data: MaskedSettings;
  description?: ReactNode;
  deliveryTest?: DeliveryTest;
  renderField?: FieldRenderer;
  renderExtra?: SettingsExtraRenderer;
  saving: boolean;
  resetting: boolean;
  onSave: (values: Record<string, unknown>) => Promise<void>;
  onReset: () => Promise<void>;
}): ReactNode {
  const toast = useToast();
  const [values, setValues] = useState(() => initialValues(data));
  const [initial] = useState(() => initialValues(data));
  // Bumped by Cancel to remount the fields: JSON editors hold their own text.
  const [revision, setRevision] = useState(0);
  const [storedSecrets] = useState(
    () => new Set(data.fields.filter(f => f.secret && data.values[f.key] === SECRET_SENTINEL).map(f => f.key)),
  );
  const [jsonErr, setJsonErr] = useState<Record<string, string>>({});
  const { editable, pending: accessPending } = useProjectCapability(
    requiredSettingsCapability(data.fields),
  );

  const hasJsonError = Object.values(jsonErr).some(Boolean);
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);

  const testDelivery = useMutation({
    mutationFn: (to: string) => deliveryTest!.send(to),
    onSuccess: (r, to) => toast.push({ kind: 'success', title: `Test sent to ${to}`, message: `${r.ms}ms` }),
    onError: (e: unknown) =>
      toast.push({ kind: 'error', title: 'Test failed', message: getErrorMessage(e) }),
  });

  function submit() {
    if (hasJsonError) {
      toast.push({ kind: 'error', title: 'Fix invalid JSON before saving' });
      return;
    }
    const payload: Record<string, unknown> = { ...values };
    // Untouched secret (blank) ⇒ send sentinel so the server keeps the stored value.
    for (const f of data.fields) if (f.secret && !payload[f.key]) payload[f.key] = SECRET_SENTINEL;
    void onSave(payload);
  }

  async function confirmReset() {
    const confirmed = await confirmDialog({
      title: `Reset "${data.label}"?`,
      description: 'The database override is deleted and the group falls back to its environment values.',
      confirmLabel: 'Reset to .env',
      tone: 'danger',
    });
    if (confirmed) void onReset();
  }

  function cancel() {
    setValues(initial);
    setJsonErr({});
    setRevision(r => r + 1);
  }

  async function sendTest() {
    if (!deliveryTest) return;
    const to = await promptDialog({ ...deliveryTest.prompt, confirmLabel: 'Send' });
    if (to) testDelivery.mutate(to);
  }

  const busy = saving || resetting;
  const footer = (
    <>
      <span className="mr-auto text-[12px]" style={{ color: 'var(--text-mute)' }}>
        {data.source === 'db' ? (
          <button
            className="underline-offset-2 hover:underline disabled:no-underline"
            onClick={() => void confirmReset()}
            disabled={!editable || busy}
          >
            {resetting ? 'Resetting…' : 'Reset to .env'}
          </button>
        ) : (
          'Using .env values'
        )}
      </span>
      {deliveryTest && (
        <button
          className="btn"
          onClick={() => void sendTest()}
          disabled={!editable || dirty || testDelivery.isPending}
          title={dirty ? 'Save first: the test uses the saved settings' : undefined}
        >
          {testDelivery.isPending ? 'Sending…' : deliveryTest.label}
        </button>
      )}
      {dirty && <button className="btn" onClick={cancel} disabled={busy}>Cancel</button>}
      <button className="btn btn-primary" onClick={submit} disabled={!editable || !dirty || hasJsonError || busy}>
        {saving ? 'Saving…' : 'Save changes'}
      </button>
    </>
  );

  return (
    <Section title={data.label} description={description} footer={footer}>
      <SettingsFields
        key={revision}
        fields={data.fields}
        values={values}
        setField={(key: string, value: unknown) => setValues(s => ({ ...s, [key]: value }))}
        editable={editable}
        jsonErr={jsonErr}
        setJsonErr={setJsonErr}
        renderField={renderField}
        storedSecrets={storedSecrets}
      />
      <SettingsAccessNotice editable={editable} pending={accessPending} />
      {renderExtra?.({ values, dirty, editable })}
    </Section>
  );
}
