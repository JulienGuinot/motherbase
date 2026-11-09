import { getErrorMessage } from '@/shared/lib/errors';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { platform } from '@/shared/lib/api';
import { useToast } from '@/shared/lib/toast';
import { UpdatePanel } from '@/features/platform/components/UpdatePanel';
import { SettingRow } from '@/shared/ui/Row';
import { Section } from '@/shared/ui/Section';

const SERVER_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: 'adminEmail', label: 'Admin email', hint: 'Login identity for this console' },
  { key: 'apiImage', label: 'Default API image', hint: 'Docker image used when creating new projects' },
  { key: 'domainSuffix', label: 'Domain suffix', hint: 'Base domain for project subdomains' },
  { key: 'certResolver', label: 'Cert resolver', hint: 'Traefik ACME resolver for TLS' },
  { key: 'traefikNetwork', label: 'Traefik network', hint: 'Shared docker network for the proxy' },
  { key: 'alertWebhookUrl', label: 'Resource alert webhook', hint: 'Discord, Slack or any URL taking a JSON POST. Fires when a project crosses the thresholds below, at most every 15 minutes per project.' },
  { key: 'alertCpuThreshold', label: 'Alert CPU threshold (%)', hint: '85 when blank' },
  { key: 'alertMemThreshold', label: 'Alert memory threshold (%)', hint: '85 when blank' },
];

export function ServerTab() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['platform-settings'], queryFn: platform.settings });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const form: Record<string, string> = {};
  for (const field of SERVER_FIELDS) form[field.key] = q.data?.[field.key] ?? '';
  Object.assign(form, edits);

  const save = useMutation({
    mutationFn: () => platform.updateSettings(form),
    onSuccess: r => toast.push({ kind: 'success', title: 'Settings saved', message: `Updated ${r.updated.join(', ')}` }),
    onError: (e) => toast.push({ kind: 'error', title: 'Save failed', message: getErrorMessage(e) }),
  });

  if (q.isLoading) return <div className="card h-64 shimmer" />;

  const dirty = q.data && SERVER_FIELDS.some(f => (form[f.key] ?? '') !== (q.data[f.key] ?? ''));

  return (
    <div className="space-y-6">
      <UpdatePanel />
      <form onSubmit={e => { e.preventDefault(); save.mutate(); }}>
        <Section
          title="Server configuration"
          description="Console-wide values. They take effect immediately and apply to projects created from now on."
          actions={<span className="chip">{q.data?.mode} mode</span>}
          bodyClassName="space-y-3"
          footer={
            <button type="submit" disabled={!dirty || save.isPending} className="btn btn-primary">
              <Save size={12} /> {save.isPending ? 'Saving…' : 'Save changes'}
            </button>
          }
        >
          {SERVER_FIELDS.map(f => (
            <SettingRow key={f.key} label={f.label} hint={f.hint}>
              <div className="w-full sm:w-72">
                <input
                  value={form[f.key] ?? ''}
                  onChange={e => setEdits(current => ({ ...current, [f.key]: e.target.value }))}
                  className="input"
                  aria-label={f.label}
                />
              </div>
            </SettingRow>
          ))}
        </Section>
      </form>
    </div>
  );
}
