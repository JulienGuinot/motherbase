import { useState, type ReactNode } from 'react';
import { Trash2, Plus } from 'lucide-react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import type { BucketWebhook, CreateBucketWebhookInput } from '@/features/storage/components/storage.types';
import { Field } from '@/shared/ui/Field';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';

interface Props {
  notice?: ReactNode;
  bucketName: string;
  webhooks: BucketWebhook[];
  onClose: () => void;
  onAdd: (data: CreateBucketWebhookInput) => Promise<void>;
  onRemove: (id: string) => void;
  saving: boolean;
  multiple?: boolean;
}

const ALL_EVENTS = ['file.uploaded', 'file.deleted'] as const;

export function BucketWebhooksModal({ bucketName, webhooks, onClose, onAdd, onRemove, saving, multiple = false, notice }: Props) {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['file.uploaded']);

  function toggleEvent(e: string) {
    setEvents(prev => prev.includes(e) ? prev.filter(x => x !== e) : [...prev, e]);
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    await onAdd({ url, events });
    setUrl('');
    setEvents(['file.uploaded']);
    setAdding(false);
  }

  return (
    <Modal onClose={onClose} width="520px">
      <div className="flex flex-col min-h-0 flex-1">
        <ModalHeader title={`Webhooks · ${bucketName}`} />
        <ModalBody className="space-y-4">
          {notice}
          {multiple && <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>Adds this endpoint to each selected bucket. Existing webhooks are preserved. Select one bucket to manage its webhooks.</p>}
          {webhooks.length > 0 && (
            <div className="space-y-1">
              {webhooks.map(wh => (
                <div key={wh.id} className="flex items-center gap-3 px-3 py-2 border hairline" style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
                  <div className="flex-1 min-w-0">
                    <div className="mono text-[11px] truncate">{wh.url}</div>
                    <div className="flex gap-1.5 mt-1">
                      {wh.events.map(e => (
                        <span key={e} className="chip text-[10px] mono">{e}</span>
                      ))}
                    </div>
                  </div>
                  <button
                    onClick={async () => { if (await confirmDialog({ title: 'Remove this webhook?', description: 'Bucket events stop being delivered to it.', confirmLabel: 'Remove', tone: 'danger' })) onRemove(wh.id); }}
                    className="btn btn-ghost shrink-0"
                    style={{ color: 'var(--danger)' }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {!multiple && webhooks.length === 0 && !adding && (
            <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>No webhooks configured.</p>
          )}

          {adding ? (
            <form onSubmit={submit} className="space-y-3 border hairline p-3" style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
              <Field label="URL">
                <input
                  type="url"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  className="input mono"
                  placeholder="https://your-app.com/hooks/storage"
                  required
                />
              </Field>
              <div>
                <span className="label mb-1 block">Events</span>
                <div className="flex gap-2">
                  {ALL_EVENTS.map(ev => (
                    <button
                      key={ev}
                      type="button"
                      aria-pressed={events.includes(ev)}
                      onClick={() => toggleEvent(ev)}
                      className="mono border hairline px-2.5 py-1 text-[11px]"
                      style={{
                        background: events.includes(ev) ? 'var(--hover)' : 'transparent',
                        color: events.includes(ev) ? 'var(--text)' : 'var(--text-mute)',
                        borderRadius: 'var(--radius-sm)',
                      }}
                    >
                      {ev}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setAdding(false)} className="btn">Cancel</button>
                <button type="submit" disabled={!url || events.length === 0 || saving} className="btn btn-primary">
                  {saving ? 'Adding…' : 'Add webhook'}
                </button>
              </div>
            </form>
          ) : (
            <button onClick={() => setAdding(true)} className="btn w-full justify-center">
              <Plus size={12} /> Add webhook
            </button>
          )}
        </ModalBody>
        <ModalFooter>
          <button onClick={onClose} className="btn ml-auto">Close</button>
        </ModalFooter>
      </div>
    </Modal>
  );
}
