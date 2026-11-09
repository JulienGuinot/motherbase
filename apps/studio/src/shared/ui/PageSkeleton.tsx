import { Skeleton } from '@/shared/ui/Skeleton';

/**
 * Route-level placeholder, in the shape of a console page rather than a
 * spinner.
 *
 * App Router suspends a route segment while its JavaScript chunk is fetched.
 * With no `loading.tsx` there is no boundary to suspend against, so the browser
 * simply sits on the page you are leaving: clicking a nav entry did nothing
 * visible until the chunk landed, which reads as a dropped click and gets
 * clicked again.
 *
 * A silhouette rather than "Loading page…": it occupies the layout the real
 * page is about to fill, so the switch is a fill-in rather than a replacement,
 * and it never announces slowness the way a spinner does.
 */
export function PageSkeleton() {
  return (
    <div className="px-4 py-5 sm:px-8 sm:py-7" role="status" aria-label="Loading page">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <Skeleton style={{ height: 20, width: 180 }} />
            <Skeleton style={{ height: 12, width: 260 }} />
          </div>
          <Skeleton style={{ height: 30, width: 110 }} />
        </div>
        <Skeleton style={{ height: 120 }} />
        <Skeleton style={{ height: 200 }} />
      </div>
    </div>
  );
}

export default PageSkeleton;
