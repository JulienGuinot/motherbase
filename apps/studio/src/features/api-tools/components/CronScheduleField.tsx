import { useState } from 'react';
import { Clock, X } from 'lucide-react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';

import { describeCron, isValidCron, PRESETS } from '@/features/api-tools/lib/cron-schedule';

interface Props {
  value: string; // current cron expression ('' = not scheduled)
  onChange: (next: string) => void;
}

/**
 * Schedule editor for an edge function. Replaces the bare "not scheduled" input
 * with a labelled trigger + modal that explains what a cron schedule is, offers
 * one-click presets, validates the expression, and shows a live plain-English
 * summary so operators aren't left guessing what to type.
 */
export default function CronScheduleField({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const scheduled = !!value.trim();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="chip flex items-center gap-1.5"
        style={{ color: scheduled ? 'var(--text)' : 'var(--text-mute)' }}
        title="Edit run schedule"
      >
        <Clock size={11} style={{ color: scheduled ? 'var(--accent)' : 'var(--text-mute)' }} />
        {scheduled ? describeCron(value) : 'Not scheduled'}
      </button>
      {open && (
        <ScheduleModal
          initial={value}
          onClose={() => setOpen(false)}
          onSave={next => { onChange(next); setOpen(false); }}
        />
      )}
    </>
  );
}

function ScheduleModal({ initial, onClose, onSave }: { initial: string; onClose: () => void; onSave: (v: string) => void }) {
  const [expr, setExpr] = useState(initial);
  const trimmed = expr.trim();
  const valid = trimmed === '' || isValidCron(trimmed);

  return (
    <Modal onClose={onClose} width="520px">
      <ModalHeader
        eyebrow="Edge function"
        title="Run schedule"
        description="Run this function automatically on a timer using the same sandbox as an on-demand invoke. Leave empty to run only when invoked. Uses standard 5-field cron (UTC)."
      />
      <ModalBody className="space-y-5">
        <div>
          <span className="label">Presets</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {PRESETS.map(p => (
              <button
                key={p.expr}
                type="button"
                onClick={() => setExpr(p.expr)}
                className="chip"
                style={{
                  cursor: 'pointer',
                  borderColor: trimmed === p.expr ? 'var(--accent)' : undefined,
                  color: trimmed === p.expr ? 'var(--accent)' : undefined,
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="label">Cron expression</span>
          <div className="mt-2 flex items-center gap-2">
            <input
              value={expr}
              onChange={e => setExpr(e.target.value)}
              placeholder="e.g. 0 * * * *   (minute hour day month weekday)"
              className="input mono w-full"
              spellCheck={false}
            />
            {trimmed && (
              <button type="button" onClick={() => setExpr('')} className="btn btn-ghost shrink-0 p-1.5" title="Clear schedule">
                <X size={14} />
              </button>
            )}
          </div>
          <div className="mt-2 text-[12px]" style={{ color: valid ? 'var(--text-mute)' : 'var(--danger)' }}>
            {trimmed === ''
              ? 'Not scheduled. Runs only on manual/HTTP invoke.'
              : valid
                ? `Runs: ${describeCron(trimmed)}`
                : 'Invalid cron expression: expected 5 space-separated fields.'}
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
        <button type="button" disabled={!valid} onClick={() => onSave(trimmed)} className="btn btn-primary">
          Save schedule
        </button>
      </ModalFooter>
    </Modal>
  );
}
