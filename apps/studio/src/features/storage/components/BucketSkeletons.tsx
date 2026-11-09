export function BucketSkeletons() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-2">
          <div className="shimmer h-5 w-40" />
          <div className="shimmer h-3 w-56" />
        </div>
      </div>
      <div className="card flex flex-wrap items-center gap-3 p-3">
        <div className="shimmer h-8 flex-1 min-w-[200px]" />
        <div className="shimmer h-8 w-48" />
        <div className="shimmer h-8 w-24" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="card flex flex-col">
            <div className="shimmer aspect-square" />
            <div className="border-t hairline p-3 space-y-2">
              <div className="shimmer h-3 w-3/4" />
              <div className="shimmer h-2.5 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
