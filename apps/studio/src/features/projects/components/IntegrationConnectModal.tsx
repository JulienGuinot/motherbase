import { getErrorMessage } from '@/shared/lib/errors';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { projectsApi } from '@/features/projects/api/projects.api';
import { useToast } from '@/shared/lib/toast';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import type { Integration } from '@/features/projects/types';
import { Checkbox } from '@/shared/ui/Field';

export function IntegrationConnectModal({
  integration,
  onClose,
  onConnected,
}: {
  integration: Integration;
  onClose: () => void;
  onConnected: () => void;
}) {
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  // Everything not already installed is pre-picked: the common case is "give me
  // the lot", and unchecking three boxes is cheaper than hunting for the one.
  const [picked, setPicked] = useState<string[]>(() =>
    integration.functions.filter(fn => !fn.installed).map(fn => fn.route),
  );

  const connectM = useMutation({
    mutationFn: () =>
      projectsApi.connectIntegration(integration.key, values, picked.length > 0, picked),
    onSuccess: ({ data }) => {
      const installed = (data.data?.installed ?? []) as string[];
      toast.push({
        kind: 'success',
        title: `${integration.name} connected`,
        message: installed.length ? `Installed: ${installed.join(', ')}` : undefined,
      });
      onConnected();
    },
    onError: (e) => toast.push({ kind: 'error', title: 'Connect failed', message: getErrorMessage(e) }),
  });

  // Required = every non-optional, not-yet-set secret has a value typed in.
  const missingRequired = integration.secrets.some(
    s => !s.optional && !s.set && !String(values[s.name] ?? '').trim(),
  );
  const exampleFunctions = integration.functions.filter(
    fn => fn.readiness === 'example' && picked.includes(fn.route),
  );
  const pickedWebhooks = integration.functions.filter(
    fn => fn.kind === 'webhook' && picked.includes(fn.route),
  );
  const toggle = (route: string) =>
    setPicked(current =>
      current.includes(route) ? current.filter(r => r !== route) : [...current, route],
    );
  const installable = integration.functions.filter(fn => !fn.installed);

  return (
    <Modal onClose={onClose} width="520px">
      <ModalHeader title={`Connect ${integration.name}`} />
      <ModalBody className="space-y-4">
        {integration.secrets.map(s => (
          <label key={s.name} className="block">
            <span className="label mb-1.5 block">
              {s.label} <span className="mono" style={{ color: 'var(--text-mute)' }}>({s.name})</span>
              {s.set && <span className="ml-2" style={{ color: 'var(--green)' }}>already set. Leave blank to keep</span>}
            </span>
            <input
              type="password"
              value={values[s.name] ?? ''}
              onChange={e => setValues(v => ({ ...v, [s.name]: e.target.value }))}
              className="input mono"
              placeholder={s.placeholder}
            />
          </label>
        ))}

        {integration.functions.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="label">Functions to install</span>
              {installable.length > 0 && (
                <button
                  type="button"
                  className="chip"
                  onClick={() =>
                    setPicked(
                      picked.length === installable.length ? [] : installable.map(fn => fn.route),
                    )
                  }
                >
                  {picked.length === installable.length ? 'Clear all' : 'Select all'}
                </button>
              )}
            </div>

            {integration.functions.map(fn => (
              <div
                key={fn.route}
                className="border hairline p-2.5"
                style={{ borderRadius: 'var(--radius-sm)', opacity: fn.installed ? 0.6 : 1 }}
              >
                <div className="flex items-start gap-2">
                  {fn.installed ? (
                    <span className="chip mt-0.5" style={{ color: 'var(--green)', borderColor: 'var(--green)' }}>
                      Installed
                    </span>
                  ) : (
                    <Checkbox
                      checked={picked.includes(fn.route)}
                      onChange={() => toggle(fn.route)}
                      label=""
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="mono truncate text-[12px]">{fn.name}</span>
                      {fn.kind === 'webhook' && <span className="chip" style={{ fontSize: 10 }}>Webhook</span>}
                      {fn.readiness === 'example' && (
                        <span className="chip" style={{ color: 'var(--warning)', borderColor: 'var(--warning)' }}>
                          Example
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[11px]" style={{ color: 'var(--text-mute)' }}>{fn.description}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {pickedWebhooks.length > 0 && (
          <p className="border hairline p-3 text-[11px]" style={{ color: 'var(--text-dim)', borderRadius: 'var(--radius-sm)' }}>
            {pickedWebhooks.map(fn => fn.name).join(', ')}: a receiver only accepts deliveries once its signing
            secret is set and the provider is pointed at the function route. Both are listed on the function.
          </p>
        )}

        {exampleFunctions.length > 0 && (
          <p className="border hairline p-3 text-[11px]" style={{ color: 'var(--warning)', borderRadius: 'var(--radius-sm)' }}>
            {exampleFunctions.map(fn => fn.name).join(', ')}: example only. Add provider signature verification,
            idempotence and business logic before production use.
          </p>
        )}
      </ModalBody>
      <ModalFooter>
        <button onClick={onClose} className="btn">Cancel</button>
        <button
          onClick={() => connectM.mutate()}
          className="btn btn-primary"
          disabled={missingRequired || connectM.isPending}
        >
          {connectM.isPending ? 'Connecting…' : 'Connect'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
