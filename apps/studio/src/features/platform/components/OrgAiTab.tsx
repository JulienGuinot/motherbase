'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, Trash2 } from 'lucide-react';
import { ProviderSelect } from '@/features/assistant/components/ProviderSelect';
import { orgAiApi, type OrgAiConfig } from '@/features/platform/api/orgs.api';
import { useOrgs } from '@/shared/lib/org';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { SettingRow } from '@/shared/ui/Row';
import { Section } from '@/shared/ui/Section';
import { Toggle } from '@/shared/ui/Toggle';

const KEY_PLACEHOLDER = '••••••••••••••••';

const orgAiKey = (orgId: string) => ['org-ai', orgId] as const;

/**
 * Org > Settings > AI assistant: one model key for every project in the org.
 *
 * The project-level form (in the assistant dock) stays where it is and still
 * wins for the project that sets it. This is the default the rest inherit, so
 * an operator running eight projects pastes their key once rather than eight
 * times, and rotates it in one place.
 *
 * Saving pushes the key into each project's environment and recreates its API
 * container, which the description says out loud: it is a few seconds of
 * downtime per project, not a free change.
 */
export default function OrgAiTab() {
  const { active } = useOrgs();
  const orgId = active?.id;
  const query = useQuery({
    queryKey: orgAiKey(orgId ?? ''),
    queryFn: () => orgAiApi.get(orgId!),
    enabled: Boolean(orgId),
  });

  if (!active || !orgId) {
    return <p className="text-[13px]" style={{ color: 'var(--text-mute)' }}>No organization selected.</p>;
  }
  if (query.isPending) {
    return <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>Loading…</p>;
  }
  if (query.isError) {
    return (
      <p className="text-[13px]" style={{ color: 'var(--danger)' }}>
        {getErrorMessage(query.error, 'The organization AI settings could not be loaded')}
      </p>
    );
  }

  // Re-keyed rather than synced, like SettingsForm: switching org (or saving)
  // remounts the editor on fresh values, so no effect can wipe what the
  // operator is halfway through typing.
  return (
    <Editor
      key={`${orgId}:${query.data.updatedAt ?? 'none'}`}
      orgId={orgId}
      orgName={active.name}
      config={query.data}
      canManage={query.data.canManage}
    />
  );
}

function Editor({
  orgId,
  orgName,
  config,
  canManage,
}: {
  orgId: string;
  orgName: string;
  config: OrgAiConfig;
  canManage: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(config.enabled);
  const [provider, setProvider] = useState(config.provider || 'anthropic');
  const [model, setModel] = useState(config.model);
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  // Blank means "keep the stored key": the server never hands it back, so an
  // edit that only changes the model must not clear it.
  const [apiKey, setApiKey] = useState('');
  const descriptor = config.providers.find(p => p.id === provider);

  /** Name the projects that did not take the change, rather than reporting a
   *  clean save while some project is still on the old key. */
  function report(result: { failed: string[] }, done: string) {
    void queryClient.invalidateQueries({ queryKey: orgAiKey(orgId) });
    if (result.failed.length) {
      toast.push({
        kind: 'error',
        title: `${result.failed.length} project(s) did not take the change`,
        message: `${result.failed.join(', ')}. Restart them, then save again.`,
      });
      return;
    }
    toast.push({ kind: 'success', title: done });
  }

  const save = useMutation({
    mutationFn: () => orgAiApi.save(orgId, { enabled, provider, model, apiKey, baseUrl }),
    onSuccess: result => report(result, 'Organization AI settings saved'),
    onError: (error: unknown) =>
      toast.push({ kind: 'error', title: 'Save failed', message: getErrorMessage(error) }),
  });

  const clear = useMutation({
    mutationFn: () => orgAiApi.clear(orgId),
    onSuccess: result => report(result, 'Organization key removed'),
    onError: (error: unknown) =>
      toast.push({ kind: 'error', title: 'Could not remove the key', message: getErrorMessage(error) }),
  });

  const busy = save.isPending || clear.isPending;

  async function confirmClear() {
    const confirmed = await confirmDialog({
      title: 'Remove the organization key?',
      description:
        'The key is deleted and blanked in every project that inherits it. Projects with their own key are unaffected.',
      confirmLabel: 'Remove key',
      tone: 'danger',
    });
    if (confirmed) clear.mutate();
  }

  const locked = !canManage || busy;

  return (
    <div className="space-y-6">
      <Section
        title="AI assistant"
        description={`One model key for every project in ${orgName}. A project that saves its own key in its assistant settings keeps using it.`}
        bodyClassName="space-y-3"
        footer={
          canManage ? (
            <>
              {config.hasKey && (
                <button className="btn mr-auto" onClick={() => void confirmClear()} disabled={busy}>
                  <Trash2 size={13} /> Remove key
                </button>
              )}
              <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
                Restarts each project&apos;s API: a few seconds of downtime.
              </span>
              <button className="btn btn-primary" onClick={() => save.mutate()} disabled={busy}>
                <Save size={13} /> {save.isPending ? 'Saving…' : 'Save and push'}
              </button>
            </>
          ) : undefined
        }
      >
        <SettingRow label="Enabled" hint="When off, projects fall back to their own key, if they have one.">
          <Toggle checked={enabled} onChange={setEnabled} disabled={locked} ariaLabel="Enabled" />
        </SettingRow>
        <SettingRow label="Provider">
          <div className="w-full sm:w-72">
            <ProviderSelect
              value={provider}
              onChange={next => {
                setProvider(next);
                // The previous vendor's model id would be sent to the new one.
                setModel('');
              }}
              options={config.providers.map(p => ({ value: p.id, label: p.label }))}
              disabled={locked}
            />
          </div>
        </SettingRow>
        <SettingRow label="Model" hint="Any model id the provider accepts. Blank uses its default.">
          <div className="w-full sm:w-72">
            <input
              className="input"
              value={model}
              onChange={e => setModel(e.target.value)}
              disabled={locked}
              placeholder={descriptor?.defaultModel}
              aria-label="Model"
            />
          </div>
        </SettingRow>
        <SettingRow
          label="API key"
          hint={config.hasKey ? 'A key is stored. Leave blank to keep it.' : 'Stored encrypted, never sent back to the browser.'}
        >
          <div className="w-full sm:w-72">
            <input
              className="input"
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              disabled={locked}
              placeholder={config.hasKey ? KEY_PLACEHOLDER : ''}
              autoComplete="off"
              aria-label="API key"
            />
          </div>
        </SettingRow>
        <SettingRow
          label="Base URL"
          hint={descriptor?.requiresBaseUrl
            ? 'Required: your OpenAI-compatible server (Ollama, vLLM, LiteLLM).'
            : "Blank uses the provider's own endpoint."}
        >
          <div className="w-full sm:w-72">
            <input
              className="input"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              disabled={locked}
              placeholder={descriptor?.defaultBaseUrl ?? (descriptor?.requiresBaseUrl ? 'http://localhost:11434/v1' : '')}
              aria-label="Base URL"
            />
          </div>
        </SettingRow>
        {!canManage && (
          <p className="text-[11px]" role="status" style={{ color: 'var(--text-mute)' }}>
            Read-only: the organization key restarts every project of the organization, so changing it takes an
            organization Owner or Admin who can also manage secrets.
          </p>
        )}
      </Section>

      <Section
        title="Projects inheriting this key"
        description="Each receives the key above unless it saved one of its own."
      >
        {config.projects.length === 0 ? (
          <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>No project of yours inherits this key.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {config.projects.map(name => <span key={name} className="chip">{name}</span>)}
          </div>
        )}
      </Section>
    </div>
  );
}
