'use client';

import type { ReactNode } from 'react';
import ProductLayout from '@/shell/ProductLayout';

export default function DatabaseProductLayout({ children }: { children: ReactNode }) {
  return <ProductLayout productKey="database">{children}</ProductLayout>;
}
