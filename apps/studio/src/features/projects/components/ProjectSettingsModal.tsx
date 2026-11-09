import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react';
import { platform, type ProjectConfig, type ProjectConfigPatch } from '@/shared/lib/api';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { ListInput } from '@/shared/ui/ListInput';
import { joinList, originError, splitList } from '@/shared/lib/list-values';

type ConfigKey = keyof ProjectConfig;

interface ProjectSettingsModalProps {
  project: string;
  onClose: () => void;
  onSaved: () => void;
}

interface ConfigField {
  key: ConfigKey;
  label: string;
  hint: string;
  placeholder: string;
  mono?: boolean;
  /** Stored as "a, b" but edited one entry at a time, each checked by this. */
  listItemError?: (item: string) => string | null;
}

const ROUTING_FIELDS: ConfigField[] = [
  { key: 'domain', label: 'API domain', hint: 'Public hostname used by API clients.', placeholder: 'api.example.com' },
  { key: 'storageDomain', label: 'Storage domain', hint: 'Public hostname used to serve storage objects.', placeholder: 'storage.example.com' },
  { key: 'minioConsoleDomain', label: 'Storage console domain', hint: 'Hostname for the private MinIO administration console.', placeholder: 'minio.example.com' },
  { key: 'corsOrigins', label: 'Allowed browser origins', hint: 'Press Enter after each origin. Leave empty only when the backend policy permits it.', placeholder: 'https://app.example.com', mono: true, listItemError: originError },
];

const RUNTIME_FIELDS: ConfigField[] = [
  { key: 'apiImage', label: 'API image', hint: 'Container image and tag used by this project.', placeholder: 'ghcr.io/acme/api:1.2.0', mono: true },
  { key: 'certResolver', label: 'Certificate resolver', hint: 'Traefik resolver used to issue TLS certificates.', placeholder: 'letsencrypt', mono: true },
];

function permissionAwareMessage(error: unknown, fallback: string): string {
  if (isAxiosError(error) && error.response?.status === 403) {
    return 'Your console role cannot change this project. Ask an owner or administrator.';
  }
  return getErrorMessage(error, fallback);
}

export function ProjectSettingsModal({ project, onClose, onSaved }: ProjectSettingsModalProps) {
  const toast = useToast();
  const [edits, setEdits] = useState<Partial<Record<ConfigKey, string>>>({});
  const configQ = useQuery({
    queryKey: ['platform-project-config', project],
    queryFn: () => platform.projectConfig(project),
    retry: false,
  });

  const form = configQ.data ? { ...configQ.data, ...edits } : undefined;
  const changedKeys = form && configQ.data
    ? (Object.keys(form) as ConfigKey[]).filter(key => form[key].trim() !== configQ.data[key].trim())
    : [];
  const dirty = changedKeys.length > 0;
  const requiredFields: ConfigKey[] = ['domain', 'storageDomain', 'minioConsoleDomain', 'apiImage', 'certResolver'];
  const invalid = !form || requiredFields.some(key => !form[key].trim());

  const save = useMutation({
    mutationFn: () => {
      if (!form) throw new Error('Project configuration is not loaded');
      const patch: ProjectConfigPatch = {};
      for (const key of changedKeys) patch[key] = form[key].trim();
      return platform.updateProjectConfig(project, patch);
    },
    onSuccess: () => {
      toast.push({
        kind: 'success',
        title: 'Project configuration updated',
        message: 'Containers are being recreated with the new configuration.',
      });
      onSaved();
    },
    onError: error => toast.push({
      kind: 'error',
      title: 'Configuration update failed',
      message: permissionAwareMessage(error, 'The project configuration could not be updated.'),
    }),
  });

  async function requestClose() {
    if (save.isPending) return;
    if (!dirty || (await confirmDialog({ title: 'Discard your changes?', description: 'The project configuration you edited has not been saved.', confirmLabel: 'Discard', tone: 'danger' }))) onClose();
  }

  function renderFields(fields: ConfigField[]) {
    return fields.map(field => {
      const id = `project-config-${field.key}`;
      const value = form?.[field.key] ?? '';
      const setValue = (next: string) => setEdits(current => ({ ...current, [field.key]: next }));
      return (
      <label key={field.key} htmlFor={id} className={`block ${field.listItemError ? 'sm:col-span-2' : ''}`}>
        <span className="mb-1.5 block text-[12px]" style={{ color: 'var(--text-dim)', fontWeight: 500 }}>
          {field.label}
        </span>
        {field.listItemError ? (
          <ListInput
            id={id}
            value={splitList(value)}
            onChange={items => setValue(joinList(items))}
            placeholder={field.placeholder}
            mono={field.mono}
            validate={field.listItemError}
            disabled={!form || save.isPending}
          />
        ) : (
          <input
            id={id}
            value={value}
            onChange={event => setValue(event.target.value)}
            className={`input w-full ${field.mono ? 'mono' : ''}`}
            placeholder={field.placeholder}
            disabled={!form || save.isPending}
          />
        )}
        <p className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-mute)' }}>{field.hint}</p>
      </label>
      );
    });
  }

  return (
    <Modal onClose={requestClose} width="680px">
      <ModalHeader
        eyebrow={project}
        title="Project configuration"
        description="Manage public routing and the runtime image used by this project."
      />
      <ModalBody className="space-y-6">
        {configQ.isLoading && (
          <div className="space-y-3" role="status" aria-label="Loading project configuration">
            {[1, 2, 3, 4].map(item => <div key={item} className="shimmer h-16" />)}
          </div>
        )}

        {configQ.isError && (
          <div className="rounded-md border p-4" style={{ borderColor: 'var(--danger)', background: 'var(--surface-2)' }} role="alert">
            <p className="text-[13px]" style={{ color: 'var(--danger)', fontWeight: 600 }}>Configuration unavailable</p>
            <p className="mt-1 text-[12px]" style={{ color: 'var(--text-dim)' }}>
              {permissionAwareMessage(configQ.error, 'The project configuration could not be loaded.')}
            </p>
            <button onClick={() => configQ.refetch()} className="btn mt-3" disabled={configQ.isFetching}>
              <RefreshCw size={12} className={configQ.isFetching ? 'animate-spin' : ''} /> Retry
            </button>
          </div>
        )}

        {form && (
          <>
            <section className="space-y-4" aria-labelledby="project-routing-title">
              <div>
                <h2 id="project-routing-title" className="text-[13px]" style={{ fontWeight: 600 }}>Routing</h2>
                <p className="mt-1 text-[12px]" style={{ color: 'var(--text-mute)' }}>Domains and origins exposed by the project stack.</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">{renderFields(ROUTING_FIELDS)}</div>
            </section>

            <section className="space-y-4 border-t pt-5 hairline" aria-labelledby="project-runtime-title">
              <div>
                <h2 id="project-runtime-title" className="text-[13px]" style={{ fontWeight: 600 }}>Runtime</h2>
                <p className="mt-1 text-[12px]" style={{ color: 'var(--text-mute)' }}>Deployment inputs owned by this project.</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">{renderFields(RUNTIME_FIELDS)}</div>
            </section>

            <div className="flex items-start gap-2 rounded-md border p-3" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-2)' }}>
              <AlertTriangle size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--amber)' }} />
              <div>
                <p className="text-[12px]" style={{ color: 'var(--text)', fontWeight: 600 }}>Saving recreates the project stack</p>
                <p className="mt-0.5 text-[11px] leading-5" style={{ color: 'var(--text-dim)' }}>
                  Expect a short interruption while containers and routing are refreshed. Project data volumes are preserved.
                </p>
              </div>
            </div>
          </>
        )}

        <div className="flex justify-center border-t hairline pt-4">
          <button
            className="btn"
            style={{ color: 'var(--red)', borderColor: 'var(--border)' }}
            onClick={async () => {
              if (await confirmDialog({
                title: `Destroy project "${project}"?`,
                description: 'Its containers, volumes and database are permanently removed.',
                confirmLabel: 'Destroy project',
                tone: 'danger',
                typeToConfirm: project,
              })) {
                platform.destroy(project);
              }
            }}
          >
            <Trash2 size={13} /> Delete project
          </button>
        </div>
      </ModalBody>
      <ModalFooter className="items-center">
        {dirty && (
          <span className="mr-auto text-[11px]" style={{ color: 'var(--text-mute)' }}>
            {changedKeys.length} unsaved change{changedKeys.length === 1 ? '' : 's'}
          </span>
        )}
        <button onClick={requestClose} className="btn" disabled={save.isPending}>Cancel</button>
        <button
          onClick={() => save.mutate()}
          className="btn btn-primary"
          disabled={!dirty || invalid || configQ.isLoading || save.isPending}
        >
          {save.isPending ? 'Saving & recreating…' : 'Save & recreate'}
        </button>


      </ModalFooter>
    </Modal>
  );
}
