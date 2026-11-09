'use client';

import { Suspense } from 'react';
import RequireAuth from '@/shell/RequireAuth';
import { RouteLoading } from '@/shared/ui/RouteLoading';
import GitCallback from '@/features/database/pages/GitCallback';

// Top level, not under /p/[id]: a GitHub OAuth App has one registered callback
// URL, and it cannot carry a project id. The page routes back to the project
// itself once the exchange is done.
export default function GitCallbackPage() {
  return (
    <RequireAuth>
      {/* useSearchParams needs a Suspense boundary to prerender. */}
      <Suspense fallback={<RouteLoading />}>
        <GitCallback />
      </Suspense>
    </RequireAuth>
  );
}
