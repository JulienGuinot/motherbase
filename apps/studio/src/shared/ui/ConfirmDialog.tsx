'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';

export interface ConfirmOptions {
  title: string;
  /** Body copy: what happens, and whether it can be undone. */
  description?: string;
  /** Label of the affirmative button. Defaults to "Confirm". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` paints the confirm button red. Use for anything that destroys data. */
  tone?: 'default' | 'danger';
  /**
   * Require the operator to type this string before the confirm button unlocks.
   * Reserved for the irreversible ones (drop table, drop column, delete
   * project): a click you can make by reflex is not a decision.
   */
  typeToConfirm?: string;
}

/** The text field that turns a confirmation into a prompt. */
interface PromptField {
  placeholder?: string;
  type?: 'text' | 'email' | 'tel';
}

export type PromptOptions = Omit<ConfirmOptions, 'tone' | 'typeToConfirm'> & PromptField;

// `settle` receives the typed text on confirm (empty for a plain confirmation),
// null on dismiss; each public call maps that onto its own return type.
type Pending = ConfirmOptions & { field?: PromptField; settle: (value: string | null) => void };

// One host renders every confirmation, so the call site stays a one-liner and
// no feature has to carry dialog state it does not otherwise need.
let mount: ((pending: Pending | null) => void) | null = null;

/**
 * Styled replacement for `window.confirm`. Native confirms render Chrome's own
 * "localhost:5173 says" chrome, cannot be styled, cannot say which of two
 * dangers you are about to trigger, and block the whole tab. The single most
 * expensive thing an otherwise polished console can put in front of an operator.
 *
 * Resolves `false` when dismissed, so `if (!(await confirmDialog(...))) return;`
 * reads like the call it replaces.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  // No host mounted (tests, SSR): fail closed rather than silently destroying
  // something because a dialog never appeared.
  if (!mount) return Promise.resolve(false);
  return new Promise(resolve => mount!({ ...options, settle: value => resolve(value !== null) }));
}

/**
 * Styled replacement for `window.prompt`, for the one value an action needs
 * (a test recipient, a view name). Resolves the trimmed text, or null when
 * dismissed; the confirm button stays locked while the field is empty.
 */
export function promptDialog({ placeholder, type, ...options }: PromptOptions): Promise<string | null> {
  if (!mount) return Promise.resolve(null);
  return new Promise(resolve => mount!({ ...options, field: { placeholder, type }, settle: resolve }));
}

export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    mount = next => {
      setTyped('');
      setPending(next);
    };
    return () => {
      mount = null;
    };
  }, []);

  if (!pending) return null;

  const danger = pending.tone === 'danger';
  const locked = pending.typeToConfirm
    ? typed.trim() !== pending.typeToConfirm
    : Boolean(pending.field) && !typed.trim();

  const settle = (ok: boolean) => {
    pending.settle(ok ? typed.trim() : null);
    setPending(null);
  };

  return (
    <Modal onClose={() => settle(false)} width="440px">
      <ModalHeader title={pending.title} description={pending.description} />
      <ModalBody>
        {pending.typeToConfirm ? (
          <label className="block text-[12px]" style={{ color: 'var(--text-dim)' }}>
            Type <span className="mono" style={{ color: 'var(--text)' }}>{pending.typeToConfirm}</span> to confirm.
            <input
              className="input mt-2"
              autoFocus
              value={typed}
              onChange={event => setTyped(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !locked) settle(true);
              }}
              placeholder={pending.typeToConfirm}
              aria-label={`Type ${pending.typeToConfirm} to confirm`}
            />
          </label>
        ) : pending.field ? (
          <input
            className="input w-full"
            autoFocus
            type={pending.field.type ?? 'text'}
            value={typed}
            onChange={event => setTyped(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !locked) settle(true);
            }}
            placeholder={pending.field.placeholder}
            aria-label={pending.title}
          />
        ) : (
          danger && (
            <p className="flex items-start gap-2 text-[12px]" style={{ color: 'var(--text-dim)' }}>
              <AlertTriangle size={14} className="mt-px shrink-0" style={{ color: 'var(--red)' }} />
              This cannot be undone.
            </p>
          )
        )}
      </ModalBody>
      <ModalFooter>
        <button className="btn" onClick={() => settle(false)}>
          {pending.cancelLabel ?? 'Cancel'}
        </button>
        <button
          className="btn btn-primary"
          autoFocus={!pending.typeToConfirm && !pending.field}
          disabled={locked}
          onClick={() => settle(true)}
          style={danger ? { background: 'var(--red)', borderColor: 'var(--red)', color: '#fff' } : undefined}
        >
          {pending.confirmLabel ?? 'Confirm'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
