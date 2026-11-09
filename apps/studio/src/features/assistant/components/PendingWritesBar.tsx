'use client';

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { CodeBlock } from '@/shared/ui/CodeBlock';
import type { ToolTrace } from '@/features/assistant/hooks/useAssistant';

/**
 * autoApproveWrites is off by default: every write the assistant proposes
 * (create_table, create_policy, …) stops here until the operator decides.
 * Keyed by the proposal set on the caller, so a fresh batch of proposals
 * always starts from a blank slate instead of carrying over stale decisions.
 */
export default function PendingWritesBar({
  writes,
  busy,
  onResolve,
}: {
  writes: ToolTrace[];
  busy: boolean;
  onResolve: (decisions: Record<string, boolean>) => void;
}) {
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const allDecided = writes.every(w => w.callId in decisions);

  return (
    <div className="space-y-2 border-t p-2" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}>
      <p className="text-[11px] font-medium">
        {writes.length > 1 ? 'The assistant proposed these writes' : 'The assistant proposed a write'}
      </p>
      {writes.map(w => {
        const decided = decisions[w.callId];
        return (
          <div key={w.callId} className="rounded-md border p-2" style={{ borderColor: 'var(--border)' }}>
            <span className="font-mono text-[11px]">{w.name}</span>
            <CodeBlock
              value={w.input}
              label="Proposed input"
              size="sm"
              maxHeight={128}
              wrap
              className="mt-1"
            />
            <div className="mt-1.5 flex gap-1.5">
              <button
                type="button"
                className="btn flex-1"
                aria-pressed={decided === true}
                disabled={busy}
                onClick={() => setDecisions(d => ({ ...d, [w.callId]: true }))}
                style={decided === true ? { borderColor: 'var(--green)', color: 'var(--green)' } : undefined}
              >
                <Check size={12} /> Approve
              </button>
              <button
                type="button"
                className="btn flex-1"
                aria-pressed={decided === false}
                disabled={busy}
                onClick={() => setDecisions(d => ({ ...d, [w.callId]: false }))}
                style={decided === false ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}
              >
                <X size={12} /> Reject
              </button>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        className="btn btn-primary w-full"
        disabled={!allDecided || busy}
        onClick={() => onResolve(decisions)}
      >
        {busy ? 'Applying…' : 'Apply decisions'}
      </button>
    </div>
  );
}
