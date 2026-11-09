import { CodeBlock } from '@/shared/ui/CodeBlock';
import type { Step } from '@/shared/lib/snippets';

export function StepCard({ index, step }: { index: number; step: Step }) {
  return (
    <li className="card p-5">
      <div className="flex items-center gap-3">
        <span
          className="tabular-nums flex h-7 w-7 shrink-0 items-center justify-center text-[14px]"
          style={{ background: 'var(--surface-2)', color: 'var(--accent)', borderRadius: 999, fontWeight: 600 }}
        >
          {index}
        </span>
        <h3 className="text-[18px]" style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>{step.title}</h3>
      </div>

      <CodeBlock
        value={step.code}
        label={step.file ?? step.lang}
        language={step.lang}
        className="mt-4"
        maxHeight={420}
      />

      {step.note && (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--text-mute)' }}>{step.note}</p>
      )}
    </li>
  );
}
