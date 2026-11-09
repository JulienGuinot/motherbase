import { useState } from 'react';
import { ChevronDown, ChevronRight, Check, AlertTriangle, Clock } from 'lucide-react';
import { ThinkingOrb } from '@/shared/ui/ThinkingOrb';
import { CodeBlock } from '@/shared/ui/CodeBlock';
import type { ToolTrace } from '@/features/assistant/hooks/useAssistant';

export default function ToolCallCard({ trace }: { trace: ToolTrace }) {
  const [open, setOpen] = useState(false);
  const awaitingApproval = trace.proposal && trace.result === undefined;
  const pending = !awaitingApproval && trace.result === undefined;

  return (
    <div className="rounded-md border text-[11px]" style={{ borderColor: 'var(--border)' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
        style={{ color: 'var(--text-mute)' }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="font-mono">{trace.name}</span>
        {awaitingApproval ? (
          <span className="ml-auto flex items-center gap-1" style={{ color: 'var(--amber)' }} title="Waiting for your decision">
            <Clock size={12} /> proposed
          </span>
        ) : pending ? (
          <ThinkingOrb size={11} label={`Running ${trace.name}`} />
        ) : trace.isError ? (
          <AlertTriangle size={12} style={{ color: 'var(--danger)' }} />
        ) : (
          <Check size={12} style={{ color: 'var(--green)' }} />
        )}
      </button>
      {open && (
        <CodeBlock
          value={{ input: trace.input, result: trace.result }}
          label="Tool details"
          size="sm"
          maxHeight={224}
          wrap
          style={{ borderWidth: '1px 0 0', borderRadius: 0 }}
        />
      )}
    </div>
  );
}
