import type React from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Cpu, MemoryStick, Clock, Route } from 'lucide-react';
import { platform, type ProxyMetricsRow } from '@/shared/lib/api';
import { EmptyState } from '@/shared/ui/EmptyState';
import { Section } from '@/shared/ui/Section';

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}
function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

function Bar({ percent }: { percent: number }) {
  return (
    <div className="mt-3 h-1.5 w-full overflow-hidden" style={{ background: 'var(--surface-2)', borderRadius: 999 }}>
      <div className="h-full transition-all" style={{ width: `${Math.max(2, percent)}%`, background: 'var(--accent)', borderRadius: 999 }} />
    </div>
  );
}

function Gauge({ icon: Icon, label, percent, sub }: {
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>; label: string; percent: number; sub: string;
}) {
  return (
    <div className="card p-5 flex flex-col justify-between">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--text-dim)' }}><Icon size={13} style={{ color: 'var(--text-mute)' }} /> {label}</span>
        <span className="text-[22px] tabular-nums" style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>{percent}%</span>
      </div>
      <Bar percent={percent} />
      <div className="mt-2 text-[11px]" style={{ color: 'var(--text-mute)' }}>{sub}</div>
    </div>
  );
}

export function MonitorTab() {
  const q = useQuery({
    queryKey: ['platform-metrics'],
    queryFn: platform.metrics,
    refetchInterval: 5000,
  });
  const proxyQ = useQuery({
    queryKey: ['platform-proxy-metrics'],
    queryFn: platform.proxyMetrics,
    refetchInterval: 5000,
  });

  const host = q.data?.host ?? null;
  const proxyRows = proxyQ.data ?? [];
  const proxyMax = Math.max(1, ...proxyRows.map(r => r.total));

  if (q.isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-3">
        {[1, 2, 3].map(i => <div key={i} className="card h-28 shimmer" />)}
      </div>
    );
  }

  if (!host) {
    return (
      <p className="card p-12 text-center text-sm" style={{ color: 'var(--paper-mute)' }}>
        Host metrics are unavailable in this environment.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {/* Host cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Gauge icon={Cpu} label="CPU load" percent={host.loadPercent}
          sub={`${host.loadAvg[0].toFixed(2)} load · ${host.cpuCount} cores`} />
        <Gauge icon={MemoryStick} label="Memory" percent={host.memPercent}
          sub={`${fmtBytes(host.memUsed)} / ${fmtBytes(host.memTotal)}`} />
        <div className="card p-5 flex flex-col justify-between">
          <div className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--text-dim)' }}><Clock size={13} style={{ color: 'var(--text-mute)' }} /> Service uptime</div>
          <div className="mt-2 text-[26px] leading-none tabular-nums" style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>{fmtUptime(host.uptimeSec)}</div>
          <div className="mt-2 truncate text-[11px]" style={{ color: 'var(--text-mute)' }}>
            {host.hostname} · {host.platform}
          </div>
        </div>
      </div>

      <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
        Per-project CPU, memory and disk are on <Link href="/usage" className="underline">Usage</Link>.
      </p>

      {/* Proxy request distribution */}
      <Section
        title={<span className="flex items-center gap-2"><Route size={13} style={{ color: 'var(--text-mute)' }} /> Requests routed by the proxy</span>}
        actions={<span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>Since the console process started</span>}
        flush
      >
        {proxyRows.length === 0 ? (
          <EmptyState title="No proxied requests yet" description="REST, Edge and admin calls the console proxy has routed to each project show up here." />
        ) : (
          <div className="overflow-auto px-5 pb-5 pt-3">
            <table className="console">
              <thead>
                <tr><th>Project</th><th>REST</th><th>Edge</th><th>Admin</th><th>Total</th><th /></tr>
              </thead>
              <tbody>
                {proxyRows.map((row: ProxyMetricsRow) => (
                  <tr key={row.projectId}>
                    <td className="text-[13px]" style={{ fontWeight: 500 }}>{row.projectId}</td>
                    <td className="tabular-nums">{row.rest}</td>
                    <td className="tabular-nums">{row.edge}</td>
                    <td className="tabular-nums">{row.admin}</td>
                    <td className="tabular-nums">{row.total}</td>
                    <td style={{ width: '30%' }}>
                      <Bar percent={(row.total / proxyMax) * 100} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
