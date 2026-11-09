import { useState, type ReactNode } from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import type { BucketCorsConfig } from '@/features/storage/components/storage.types';
import { Field } from '@/shared/ui/Field';
import { ListInput } from '@/shared/ui/ListInput';
import { originError } from '@/shared/lib/list-values';

interface Props {
  notice?: ReactNode;
  bucketName: string;
  initial: BucketCorsConfig | null;
  saving: boolean;
  onClose: () => void;
  onSave: (data: BucketCorsConfig) => void;
  onDelete: () => void;
  multiple?: boolean;
}

const ALL_METHODS = ['GET', 'HEAD', 'PUT', 'POST', 'PATCH', 'DELETE', 'OPTIONS'];

const PRESETS: Record<string, BucketCorsConfig> = {
  'Public CDN': {
    allowedOrigins: ['*'],
    allowedMethods: ['GET', 'HEAD'],
    allowedHeaders: ['*'],
    maxAgeSec: 86400,
  },
  'Private App': {
    allowedOrigins: [],
    allowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAgeSec: 3600,
  },
};

export function BucketCorsModal({ bucketName, initial, saving, onClose, onSave, onDelete, multiple = false, notice }: Props) {
  const [origins, setOrigins] = useState<string[]>(initial?.allowedOrigins ?? []);
  const [methods, setMethods] = useState<string[]>(initial?.allowedMethods ?? ['GET', 'HEAD']);
  const [headers, setHeaders] = useState<string[]>(initial?.allowedHeaders ?? ['*']);
  const [maxAge, setMaxAge] = useState(String(initial?.maxAgeSec ?? 3600));

  function applyPreset(name: keyof typeof PRESETS) {
    const p = PRESETS[name];
    setOrigins(p.allowedOrigins);
    setMethods(p.allowedMethods);
    setHeaders(p.allowedHeaders);
    setMaxAge(String(p.maxAgeSec));
  }

  function toggleMethod(m: string) {
    setMethods(prev => prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      allowedOrigins: origins,
      allowedMethods: methods,
      allowedHeaders: headers,
      maxAgeSec: Number(maxAge),
    });
  }

  return (
    <Modal onClose={onClose} width="540px">
      <form onSubmit={submit} className="flex flex-col min-h-0 flex-1">
        <ModalHeader title={`CORS configuration · ${bucketName}`} />
        <ModalBody className="space-y-4">
          {notice}
          <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
            App CORS is always inherited. These rules allow additional origins on bucket URLs,
            without session cookies. {multiple && 'Saving replaces the additional CORS rules of every selected bucket.'}
          </p>
          <div className="flex gap-2">
            {Object.keys(PRESETS).map(p => (
              <button
                key={p}
                type="button"
                onClick={() => applyPreset(p)}
                className="btn text-[11px]"
              >
                {p}
              </button>
            ))}
          </div>

          <Field label="Additional origins" htmlFor="bucket-cors-origins" hint="App origins need not be repeated. Press Enter after each additional origin. Use * for all origins.">
            <ListInput
              id="bucket-cors-origins"
              value={origins}
              onChange={setOrigins}
              mono
              placeholder="https://app.example.com"
              validate={origin => originError(origin, { allowWildcard: true })}
            />
          </Field>

          <div>
            <span className="label mb-1.5 block">Allowed methods</span>
            <div className="flex flex-wrap gap-2">
              {ALL_METHODS.map(m => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={methods.includes(m)}
                  onClick={() => toggleMethod(m)}
                  className="mono border hairline px-2.5 py-1 text-[11px]"
                  style={{
                    background: methods.includes(m) ? 'var(--hover)' : 'var(--surface-2)',
                    color: methods.includes(m) ? 'var(--text)' : 'var(--text-mute)',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <Field label="Allowed headers" htmlFor="bucket-cors-headers">
            <ListInput id="bucket-cors-headers" value={headers} onChange={setHeaders} mono placeholder="Authorization" />
          </Field>

          <Field label="Max age (seconds)">
            <input
              type="number"
              min="0"
              max="86400"
              required
              value={maxAge}
              onChange={e => setMaxAge(e.target.value)}
              className="input w-32 tabular-nums"
            />
          </Field>
        </ModalBody>
        <ModalFooter>
          {(initial || multiple) && (
            <button type="button" disabled={saving} onClick={onDelete} className="btn mr-auto">
              Use app CORS only
            </button>
          )}
          <button type="button" onClick={onClose} className="btn">Cancel</button>
          <button type="submit" disabled={saving || !methods.length || !headers.length} className="btn btn-primary">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
