import { getErrorMessage } from '@/shared/lib/errors';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { platform } from '@/shared/lib/api';
import { usePlatformSettings } from '@/features/projects/hooks/useProjects';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { useToast } from '@/shared/lib/toast';
import { Field } from '@/shared/ui/Field';

export function AlertSettingsModal({ cpuThreshold, memThreshold, onChangeCpu, onChangeMem, onClose }: {
  cpuThreshold: number;
  memThreshold: number;
  onChangeCpu: (v: number) => void;
  onChangeMem: (v: number) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const settingsQ = usePlatformSettings();
  const [webhookUrlDraft, setWebhookUrlDraft] = useState<string | null>(null);
  const webhookUrl = webhookUrlDraft ?? settingsQ.data?.alertWebhookUrl ?? '';

  const save = useMutation({
    mutationFn: () => platform.updateSettings({
      alertWebhookUrl: webhookUrl,
      alertCpuThreshold: String(cpuThreshold),
      alertMemThreshold: String(memThreshold),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platform-settings'] });
      toast.push({ kind: 'success', title: 'Alert settings saved', message: webhookUrl ? 'Webhook will fire when a project crosses these thresholds.' : 'Banner-only. No webhook URL set.' });
      onClose();
    },
    onError: (e) => toast.push({ kind: 'error', title: 'Save failed', message: getErrorMessage(e) }),
  });

  return (
    <Modal onClose={onClose} width="460px">
      <ModalHeader
        title="Resource alert thresholds"
        description="Both the on-page banner and the server-side webhook use these thresholds. Set everything here in one place."
      />
      <ModalBody className="space-y-4">
        <Field label="CPU threshold (%)">
          <input
            type="number"
            min={1}
            max={100}
            value={cpuThreshold}
            onChange={e => onChangeCpu(Number(e.target.value))}
            className="input mono"
          />
        </Field>
        <Field label="Memory threshold (%)">
          <input
            type="number"
            min={1}
            max={100}
            value={memThreshold}
            onChange={e => onChangeMem(Number(e.target.value))}
            className="input mono"
          />
        </Field>
        <Field label="Webhook URL (optional)">
          <input
            type="text"
            value={webhookUrl}
            onChange={e => setWebhookUrlDraft(e.target.value)}
            placeholder="https://discord.com/api/webhooks/... or Slack/custom"
            className="input mono"
          />
          <p className="mt-1 text-[11px]" style={{ color: 'var(--text-mute)' }}>
            Discord and Slack URLs are auto-detected; anything else gets a plain JSON POST. Checked
            server-side every 30s (15min cooldown per project), independent of this browser.
          </p>
        </Field>
      </ModalBody>
      <ModalFooter>
        <button onClick={onClose} className="btn btn-ghost">Cancel</button>
        <button onClick={() => save.mutate()} disabled={save.isPending} className="btn btn-primary">
          {save.isPending ? 'Saving…' : 'Save & apply'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
