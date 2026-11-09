'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { listProviders, testConnection, type AiConfigOverride } from '@/features/assistant/api/assistant.api';
import { ProviderSelect } from '@/features/assistant/components/ProviderSelect';
import { useAiModels } from '@/features/assistant/hooks/useAiModels';
import { useDebounced } from '@/shared/hooks/useDebounced';
import { getErrorMessage } from '@/shared/lib/errors';
import { Note } from '@/shared/ui/Row';
import Select from '@/shared/ui/Select';
import { Section } from '@/shared/ui/Section';
import SettingsForm from '@/shared/ui/SettingsForm';

const USE_DEFAULT = '';

/** The configuration the form has on screen. A blank key means "keep the saved
 *  one": the form blanks secrets rather than echoing them to the browser. */
function overrideOf(values: Record<string, unknown>): AiConfigOverride {
  return {
    provider: String(values.provider ?? '') || undefined,
    apiKey: String(values.apiKey ?? '') || undefined,
    baseUrl: String(values.baseUrl ?? '') || undefined,
  };
}

/**
 * The model field, backed by the provider's own catalogue instead of a text
 * box the operator has to type a model id into from memory.
 *
 * It follows the provider, base URL and key that are *in the form*, not the
 * saved ones, so switching provider or pasting a new key re-lists against the
 * endpoint that configuration will actually talk to. Listing against the saved
 * credentials was what left the previous provider's models on screen after a
 * switch.
 */
function ModelField({
  value,
  over,
  editable,
  onChange,
}: {
  value: string;
  over: AiConfigOverride;
  editable: boolean;
  onChange: (model: string) => void;
}) {
  // Discovery is a round trip to the provider, and a pasted key arrives one
  // character at a time through a controlled input: list once the fields settle.
  // Debounced as a string, because `over` is a fresh object on every render and
  // an object dependency would reset the timer forever, never settling.
  const settled = useDebounced(JSON.stringify(over), 600);
  const catalogue = useAiModels(JSON.parse(settled) as AiConfigOverride);
  const models = catalogue.data?.models ?? [];
  const known = models.some(m => m.id === value);

  const options = [
    {
      value: USE_DEFAULT,
      label: catalogue.data?.model ? `Provider default (${catalogue.data.model})` : 'Provider default',
    },
    ...models.map(m => ({ value: m.id, label: m.label === m.id ? m.id : `${m.label} · ${m.id}` })),
    // A model saved before it left the catalogue (or typed by hand against a
    // self-hosted endpoint) must stay selectable, not silently reset to the
    // default the next time this form is saved.
    ...(value && !known ? [{ value, label: `${value} (not in the catalogue)` }] : []),
  ];

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Select
          value={value}
          onChange={onChange}
          options={options}
          disabled={!editable}
          ariaLabel="Model"
          className="min-w-0 flex-1"
          style={{ width: '100%' }}
          searchable
        />
        <button
          type="button"
          className="btn"
          aria-label="Refresh the model list"
          title="Refresh the model list"
          onClick={() => void catalogue.refetch()}
          disabled={catalogue.isFetching}
        >
          <RefreshCw size={13} className={catalogue.isFetching ? 'animate-spin' : undefined} />
        </button>
      </div>
      <p className="text-[11px]" style={{ color: catalogue.data?.catalogue === 'fallback' ? 'var(--text-mute)' : 'var(--green)' }}>
        {catalogue.isPending
          ? 'Loading the provider catalogue…'
          : catalogue.data?.catalogue === 'provider'
            ? `${models.length} models listed by the provider.`
            : `Showing the built-in suggestions${catalogue.data?.error ? `, ${catalogue.data.error}` : ''}. Paste a working key to list the provider's own models.`}
      </p>
    </div>
  );
}

/**
 * The base URL field, whose placeholder is the endpoint the chosen provider
 * answers on when the field stays blank, so picking DeepSeek shows DeepSeek's
 * address instead of asking the operator to look it up.
 */
function BaseUrlField({
  value,
  provider,
  editable,
  onChange,
}: {
  value: string;
  provider: string;
  editable: boolean;
  onChange: (baseUrl: string) => void;
}) {
  // The registry ships with the server, so it cannot change under a page.
  const providers = useQuery({ queryKey: ['ai-providers'], queryFn: listProviders, staleTime: Infinity });
  const descriptor = providers.data?.find(p => p.id === provider);

  return (
    <input
      className="input mt-1 w-full"
      value={value}
      onChange={e => onChange(e.target.value)}
      disabled={!editable}
      placeholder={descriptor?.defaultBaseUrl ?? (descriptor?.requiresBaseUrl ? 'http://localhost:11434/v1' : '')}
      aria-label="Base URL"
    />
  );
}

/**
 * The connection test, which sends one minimal completion through the provider.
 *
 * It tests the values on screen, not the saved ones. Testing the saved
 * configuration while the form showed something else is how "Test connection"
 * came back complaining about a model the operator could not see anywhere.
 */
function ConnectionTest({ values, dirty }: { values: Record<string, unknown>; dirty: boolean }) {
  const over = overrideOf(values);
  const test = useMutation({
    mutationFn: () => testConnection({ ...over, model: String(values.model ?? '') || undefined }),
    // The failure is reported inline under the button; without this the
    // global mutation-cache handler would toast the same message again.
    onError: () => {},
  });

  return (
    <Section
      title="Connection"
      description="Sends one small request through the settings above, saved or not."
      bodyClassName="space-y-3"
    >
      <button
        type="button"
        onClick={() => test.mutate()}
        disabled={test.isPending}
        className="btn btn-primary"
      >
        {test.isPending ? 'Testing…' : 'Test connection'}
      </button>

      <div aria-live="polite">
        {test.isSuccess && (
          <p className="text-[12px]" style={{ color: 'var(--green)' }}>
            Connected to <strong>{test.data.model}</strong> in {test.data.latencyMs} ms
            {dirty ? '. These changes are still unsaved.' : '.'}
          </p>
        )}
        {test.isError && (
          <p role="alert" className="text-[12px]" style={{ color: 'var(--danger)' }}>
            {getErrorMessage(test.error, 'Connection test failed')}
          </p>
        )}
      </div>
    </Section>
  );
}

// Rendered inside the assistant dock's settings view, so it owns no page shell
// or header: the dock supplies both.
export default function AiAssistantSettings() {
  return (
    <div className="space-y-6">
      <Note>
        Choose a model provider and supply your own key. The assistant runs on the server and can
        only do what your account can do. Your key is encrypted at rest and never sent to the
        browser. Leave this off to use the key your organization provides.
      </Note>

      <SettingsForm
        group="ai.assistant"
        renderField={({ field, values, setField, editable }) =>
          field.key === 'provider' ? (
            // The generic control would leave the previous vendor's model id in
            // the field, so the form read "OpenAI / claude-opus-5" and saved it.
            // Switching provider clears the model back to that provider's
            // default; the picker beside it re-lists at the same moment.
            <ProviderSelect
              value={String(values.provider ?? field.default ?? '')}
              onChange={provider => {
                setField('provider', provider);
                setField('model', USE_DEFAULT);
              }}
              options={field.options ?? []}
              disabled={!editable}
              align="right"
            />
          ) : field.key === 'model' ? (
            <ModelField
              value={String(values.model ?? '')}
              over={overrideOf(values)}
              editable={editable}
              onChange={model => setField('model', model)}
            />
          ) : field.key === 'baseUrl' ? (
            <BaseUrlField
              value={String(values.baseUrl ?? '')}
              provider={String(values.provider ?? '')}
              editable={editable}
              onChange={baseUrl => setField('baseUrl', baseUrl)}
            />
          ) : undefined
        }
        renderExtra={({ values, dirty }) => (
          <div className="mt-5">
            <ConnectionTest values={values} dirty={dirty} />
          </div>
        )}
      />
    </div>
  );
}
