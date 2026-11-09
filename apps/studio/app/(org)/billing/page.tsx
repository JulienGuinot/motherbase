'use client';

import { RequirePlatformFeature } from '@/shell/RequireAuth';
import Billing from '@/features/platform/pages/Billing';

export default function BillingPage() {
  return (
    <RequirePlatformFeature feature="billing">
      <Billing />
    </RequirePlatformFeature>
  );
}
