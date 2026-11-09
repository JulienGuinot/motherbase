import { Trash2, X } from 'lucide-react';

/**
 * Shown only while rows are checked, so the destructive action never sits next
 * to the browse controls when nothing is picked.
 */
export function SelectionBar({
  count,
  deleting,
  onClear,
  onDelete,
}: {
  count: number;
  deleting: boolean;
  onClear: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-3 border-b hairline px-4 py-2 text-[12px]"
      style={{ background: 'var(--accent-soft)', color: 'var(--text)' }}
    >
      <span className="tabular-nums" style={{ fontWeight: 600 }}>
        {count} selected
      </span>
      <button onClick={onClear} className="btn btn-ghost" style={{ padding: '2px 6px' }}>
        <X size={12} /> Clear
      </button>
      <button
        onClick={onDelete}
        disabled={deleting}
        className="btn ml-auto"
        style={{ color: 'var(--red)', borderColor: 'var(--red)', padding: '3px 10px' }}
      >
        <Trash2 size={12} /> {deleting ? 'Deleting…' : 'Delete rows'}
      </button>
    </div>
  );
}
