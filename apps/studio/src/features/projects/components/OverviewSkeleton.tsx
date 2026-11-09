import { Skeleton } from '@/shared/ui/Skeleton';

// Loading state for the project overview: mirrors the real layout (header,
// status-card grid, activity chart, recent-activity list) so the page doesn't
// jump when data lands.
export function OverviewSkeleton() {
  return (
    <div className="rise space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-3">
          <Skeleton style={{ height: 34, width: 240 }} />
          <Skeleton style={{ height: 28, width: 'min(320px, 100%)' }} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Skeleton style={{ height: 34, width: 110 }} />
          <Skeleton style={{ height: 34, width: 90 }} />
          <Skeleton style={{ height: 34, width: 90 }} />
        </div>
      </div>

      {/* Status card grid */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card space-y-3 p-4">
            <Skeleton style={{ height: 14, width: 80 }} />
            <Skeleton style={{ height: 24, width: 120 }} />
            <Skeleton style={{ height: 12, width: 100 }} />
          </div>
        ))}
      </div>

      {/* Activity chart card */}
      <div className="card space-y-5 p-5">
        <Skeleton style={{ height: 26, width: 260 }} />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-2 rounded-lg border hairline p-3">
              <Skeleton style={{ height: 12, width: 70 }} />
              <Skeleton style={{ height: 20, width: 60 }} />
              <Skeleton style={{ height: 40, width: '100%' }} />
            </div>
          ))}
        </div>
      </div>

      {/* Recent activity list */}
      <div className="card">
        <div className="border-b hairline p-5">
          <Skeleton style={{ height: 20, width: 160 }} />
        </div>
        <ul>
          {Array.from({ length: 6 }).map((_, i) => (
            <li key={i} className="flex items-center gap-4 px-5 py-3" style={i === 0 ? undefined : { borderTop: '1px solid var(--hairline)' }}>
              <Skeleton style={{ height: 12, width: 60 }} />
              <Skeleton style={{ height: 12, width: 12, borderRadius: 999 }} />
              <Skeleton style={{ height: 12, width: 48 }} />
              <Skeleton style={{ height: 12, width: '40%' }} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
