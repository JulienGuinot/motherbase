import type { RouteMetric } from '@/features/logs/types';

export function RouteMetrics({ routes, title = 'Hot routes' }: { routes: RouteMetric[]; title?: string }) {
  if (!routes.length) return null;
  return (
    <section className="card overflow-hidden">
      <div className="border-b hairline px-4 py-3">
        <span className="text-[13px]" style={{ fontWeight: 600 }}>{title}</span>
      </div>
      <div className="overflow-x-auto">
      <table className="console w-full">
        <thead>
          <tr>
            <th>Route</th>
            <th>Count</th>
            <th>Errors</th>
            <th>Slow</th>
            <th>Avg</th>
            <th>P95</th>
          </tr>
        </thead>
        <tbody>
          {routes.slice(0, 8).map(route => (
            <tr key={route.route}>
              <td><span className="mono text-[11px]">{route.route}</span></td>
              <td>{route.count}</td>
              <td style={{ color: route.errors ? 'var(--danger)' : 'var(--text-mute)' }}>{route.errors}</td>
              <td style={{ color: route.slow ? 'var(--amber)' : 'var(--text-mute)' }}>{route.slow}</td>
              <td>{route.avgMs}ms</td>
              <td>{route.p95Ms}ms</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}
