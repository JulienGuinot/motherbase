'use client';

import dynamic from 'next/dynamic';
import type BarTrendImpl from '@/shared/ui/charts/BarTrend.impl';

/** Lazy boundary in front of recharts. See AreaTrend for why. */
const BarTrend = dynamic(() => import('@/shared/ui/charts/BarTrend.impl'), {
  ssr: false,
  loading: () => <div className="shimmer" style={{ height: 180 }} />,
}) as typeof BarTrendImpl;

export default BarTrend;
