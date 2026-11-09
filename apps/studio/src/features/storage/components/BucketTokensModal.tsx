import { useState, type ReactNode } from 'react';
import { Copy, Trash2, Plus, ShieldCheck } from 'lucide-react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { useToast } from '@/shared/lib/toast';
import type { BucketToken, CreateBucketTokenInput } from '@/features/storage/components/storage.types';
import { Field } from '@/shared/ui/Field';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { getErrorMessage } from '@/shared/lib/errors';

export interface CreatedBucketToken { bucketName: string; raw: string }

interface Props {
  notice?: ReactNode;
  bucketName: string;
  tokens: BucketToken[];
  onClose: () => void;
  onCreate: (data: CreateBucketTokenInput) => Promise<CreatedBucketToken[]>;
  onRevoke: (id: string) => void;
  multiple?: boolean;
}

const ALL_PERMS = ['read', 'write', 'delete'] as const;

export function BucketTokensModal({ bucketName, tokens, onClose, onCreate, onRevoke, multiple = false, notice }: Props) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [createdTokens, setCreatedTokens] = useState<CreatedBucketToken[]>([]);
  const [form, setForm] = useState({ name: '', permissions: ['read'] as string[], expiresAt: '' });
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const raw = await onCreate({
        name: form.name,
        permissions: form.permissions,
        expiresAt: form.expiresAt || undefined,
      });
      setCreatedTokens(previous => [...previous, ...raw]);
      setCreating(false);
      setForm({ name: '', permissions: ['read'], expiresAt: '' });
    } catch (error) {
      toast.push({ kind: 'error', title: 'Token creation failed', message: getErrorMessage(error) });
    } finally {
      setSaving(false);
    }
  }

  function togglePerm(p: string) {
    setForm(f => ({
      ...f,
      permissions: f.permissions.includes(p) ? f.permissions.filter(x => x !== p) : [...f.permissions, p],
    }));
  }

  return (
    <Modal onClose={() => { if (!saving) onClose(); }} width="560px">
      <div className="flex flex-col min-h-0 flex-1">
        <ModalHeader title={`Access tokens · ${bucketName}`} />
        <ModalBody className="space-y-4">
          {notice}
          <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
            {multiple ? 'Creates a separate token for each selected bucket with the same permissions. Each token only grants access to its own bucket.' : 'These tokens only grant access to this bucket.'}
          </p>
          {createdTokens.map(({ bucketName: name, raw }, index) => (
            <div key={index} className="p-3 border hairline space-y-2" style={{ background: 'var(--surface-2)', borderColor: 'var(--border-strong)', borderRadius: 'var(--radius-sm)' }}>
              <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-mute)' }}>
                <ShieldCheck size={13} /> {name}: save this token, it won't be shown again
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 mono text-[11px] break-all" style={{ color: 'var(--text)' }}>{raw}</code>
                <button
                  className="btn btn-ghost shrink-0"
                  aria-label={`Copy token for ${name}`}
                  onClick={() => { navigator.clipboard.writeText(raw); toast.push({ kind: 'success', title: 'Token copied' }); }}
                >
                  <Copy size={12} />
                </button>
              </div>
            </div>
          ))}

          {tokens.length > 0 && (
            <div className="space-y-1">
              {tokens.map(t => (
                <div key={t.id} className="flex items-center gap-3 px-3 py-2 border hairline" style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px]">{t.name}</div>
                    <div className="flex gap-1.5 mt-1 flex-wrap">
                      {t.permissions.map(p => (
                        <span key={p} className="chip text-[10px] capitalize">{p}</span>
                      ))}
                    </div>
                  </div>
                  {t.expiresAt && (
                    <span className="text-[11px] shrink-0" style={{ color: 'var(--text-mute)' }}>
                      exp {new Date(t.expiresAt).toLocaleDateString()}
                    </span>
                  )}
                  <button
                    onClick={async () => { if (await confirmDialog({ title: `Revoke "${t.name}"?`, description: 'Anything still presenting this token is refused immediately.', confirmLabel: 'Revoke token', tone: 'danger' })) onRevoke(t.id); }}
                    className="btn btn-ghost shrink-0"
                    style={{ color: 'var(--danger)' }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {!multiple && tokens.length === 0 && !creating && (
            <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>No tokens yet.</p>
          )}

          {creating ? (
            <form onSubmit={submit} className="space-y-3 border hairline p-3" style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
              <Field label="Token name">
                <input
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  className="input"
                  placeholder="SDK read token"
                  required
                />
              </Field>
              <div>
                <span className="label mb-1 block">Permissions</span>
                <div className="flex gap-2">
                  {ALL_PERMS.map(p => (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={form.permissions.includes(p)}
                      onClick={() => togglePerm(p)}
                      className="border hairline px-2.5 py-1 text-[11px] capitalize"
                      style={{
                        background: form.permissions.includes(p) ? 'var(--hover)' : 'transparent',
                        color: form.permissions.includes(p) ? 'var(--text)' : 'var(--text-mute)',
                        borderRadius: 'var(--radius-sm)',
                      }}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <Field label="Expires at (optional)">
                <input
                  type="date"
                  value={form.expiresAt}
                  onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))}
                  className="input"
                />
              </Field>
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setCreating(false)} className="btn">Cancel</button>
                <button type="submit" disabled={!form.name || form.permissions.length === 0 || saving} className="btn btn-primary">
                  {saving ? 'Creating…' : multiple ? 'Create one token per bucket' : 'Create token'}
                </button>
              </div>
            </form>
          ) : (
            <button onClick={() => setCreating(true)} className="btn w-full justify-center">
              <Plus size={12} /> New token
            </button>
          )}
        </ModalBody>
        <ModalFooter>
          <button disabled={saving} onClick={onClose} className="btn ml-auto">Close</button>
        </ModalFooter>
      </div>
    </Modal>
  );
}
