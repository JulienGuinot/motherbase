import type { ReactNode } from 'react';

// One setting per row: caption and hint on the left, control on the right.
// Rows stack inside a Section and separate themselves with hairlines.
export function SettingRow({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-t hairline pt-3 first:border-t-0 first:pt-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">{label}</div>
        {hint && <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-mute)' }}>{hint}</div>}
      </div>
      <div className="w-full sm:w-auto sm:shrink-0">{children}</div>
    </div>
  );
}

/** Muted explanatory block, for the note that introduces a settings group. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border hairline px-4 py-3 text-[12px] leading-relaxed" style={{ background: 'var(--surface-2)', color: 'var(--text-mute)' }}>
      {children}
    </p>
  );
}
