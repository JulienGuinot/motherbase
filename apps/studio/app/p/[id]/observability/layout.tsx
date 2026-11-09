'use client';

import type { ReactNode } from 'react';
import ProductLayout from '@/shell/ProductLayout';

export default function ObservabilityProductLayout({ children }: { children: ReactNode }) {
  return <ProductLayout productKey="observability">{children}</ProductLayout>;
}
