'use client';

import type { ReactNode } from 'react';
import ProductLayout from '@/shell/ProductLayout';

export default function AuthProductLayout({ children }: { children: ReactNode }) {
  return <ProductLayout productKey="auth">{children}</ProductLayout>;
}
