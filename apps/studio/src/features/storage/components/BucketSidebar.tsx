import { Database } from 'lucide-react';

interface BucketEntry {
  id: string;
  slug: string;
  name: string;
  visibility: 'public' | 'private';
  fileCount: number;
}

interface Props {
  buckets: BucketEntry[];
  active: string | 'all';
  onSelect: (slug: string | 'all') => void;
  loading?: boolean;
}

export function BucketSidebar({ buckets, active, onSelect, loading = false }: Props) {
  return (
    <aside className="flex w-full shrink-0 items-center gap-1 overflow-x-auto px-2 py-2 md:w-44 md:flex-col md:items-stretch md:overflow-x-hidden md:overflow-y-auto md:px-0 md:pt-4" style={{ background: 'var(--ink-2)'}} >
      <span className="hidden px-2 text-[13px] md:mb-2 md:block" style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Buckets</span>
      {loading && buckets.length === 0 &&
        Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex min-w-24 items-center gap-2 px-2 py-1.5">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full shimmer" />
            <span className="shimmer h-3 flex-1" style={{ maxWidth: `${5 + ((i * 3) % 4)}rem` }} />
          </div>
        ))}
      {!loading && buckets.length === 0 && (
        <p className="shrink-0 px-2 py-1.5 text-[11px]" style={{ color: 'var(--text-mute)' }}>
          No buckets yet
        </p>
      )}
      {buckets.map(b => (
        <button
          key={b.slug}
          onClick={() => onSelect(b.slug)}
          className="flex shrink-0 items-center gap-2 px-2 py-1.5 text-left text-[12px] transition-colors md:w-full"
          style={{
            background: active === b.slug ? 'var(--surface-2)' : 'transparent',
            color: active === b.slug ? 'var(--text)' : 'var(--text-dim)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: b.visibility === 'public' ? 'var(--green)' : 'var(--text-mute)' }}
          />
          <span className="max-w-28 truncate md:flex-1">{b.name}</span>
          <span className="tabular-nums text-[10px]" style={{ color: 'var(--text-mute)' }}>{b.fileCount}</span>
        </button>
      ))}
      <div className="mx-1 h-6 border-l hairline md:my-1 md:h-auto md:border-l-0 md:border-t" />
      <button
        onClick={() => onSelect('all')}
        className="flex shrink-0 items-center gap-2 px-2 py-1.5 text-left text-[12px] transition-colors md:w-full"
        style={{
          background: active === 'all' ? 'var(--surface-2)' : 'transparent',
          color: active === 'all' ? 'var(--text)' : 'var(--text-mute)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        <Database size={11} />
        <span>All files</span>
      </button>
    </aside>
  );
}
