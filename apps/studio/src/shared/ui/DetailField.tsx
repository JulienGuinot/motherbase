import type { ReactNode } from 'react';

interface DetailFieldProps {
  label: string;
  value: ReactNode;
  mono?: boolean;
}

export function DetailField({ label, value, mono = false }: DetailFieldProps) {
  return (
    <div >
      <div className="label mb-1">{label}</div>
      <div className={`${mono ? 'mono text-[11px]' : 'text-[13px]'} break-all`}>{value}</div>
    </div>
  );
}
