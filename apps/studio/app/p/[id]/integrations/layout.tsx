'use client';

import type { ReactNode } from 'react';
import ProductLayout from '@/shell/ProductLayout';

export default function IntegrationsProductLayout({ children }: { children: ReactNode }) {
  return <ProductLayout productKey="integrations">{children}</ProductLayout>;
}
