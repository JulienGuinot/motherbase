'use client';

import dynamic from 'next/dynamic';
import type AreaTrendImpl from '@/shared/ui/charts/AreaTrend.impl';

/**
 * Lazy boundary in front of recharts.
 *
 * recharts is the single heaviest thing the console renders (~100kB gzipped
 * with d3 behind it) and it only ever appears on the three observability pages,
 * below a header and a row of stat cards. Loading it eagerly meant the page
 * shell could not paint until the chart library had arrived. On a page whose
 * own empty state says "collecting samples, first ~10s".
 *
 * The cast restores the generic signature that `dynamic()` erases, so call
 * sites keep inferring `xKey`/`yKey` from the data they pass.
 */
const AreaTrend = dynamic(() => import('@/shared/ui/charts/AreaTrend.impl'), {
  ssr: false,
  loading: () => <div className="shimmer" style={{ height: 180 }} />,
}) as typeof AreaTrendImpl;

export default AreaTrend;
