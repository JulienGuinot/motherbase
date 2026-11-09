import { PageSkeleton } from '@/shared/ui/PageSkeleton';

// Suspense boundary for every route under this segment: navigating shows the
// page silhouette immediately instead of freezing on the page being left while
// the next route's chunk downloads.
export default function Loading() {
  return <PageSkeleton />;
}
