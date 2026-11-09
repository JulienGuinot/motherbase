import { useRouter } from 'next/navigation';
import { Server, Gauge, ShieldCheck, ArrowUpRight } from 'lucide-react';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';

// Org > Billing: this is a self-hosted platform: there is no metered vendor
// billing. Rather than fake invoices, this screen is honest about the model and
// points at the real cost lever (per-project resource quotas). If a hosted/metered
// mode is added later, the plan + invoices UI lands here.
export default function Billing() {
  const nav = useRouter();
  return (
    <PageShell>
      <PageHeader
        size="md"
        title="Billing"
        subtitle="How this platform is billed and where the cost levers are."
      />

        <div className="card flex items-start gap-4 p-6">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border hairline" style={{ background: 'var(--surface-2)' }}>
            <Server size={20} style={{ color: 'var(--green)' }} />
          </span>
          <div>
            <div className="text-[15px]" style={{ color: 'var(--text)', fontWeight: 600 }}>Self-hosted. No metered billing</div>
            <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
              You run this platform on your own infrastructure, so there is no per-seat or per-request invoice from a
              vendor. Your cost is the machine it runs on. The lever you control here is how much of that machine each
              project may consume: set per-project CPU and memory quotas so a single project can't starve the rest.
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <button onClick={() => nav.push('/usage')} className="card p-5 text-left transition-colors hover:bg-[var(--surface-2)]">
            <div className="flex items-center gap-2">
              <Gauge size={16} style={{ color: 'var(--accent)' }} />
              <span className="text-[14px]" style={{ fontWeight: 600 }}>Resource usage</span>
              <ArrowUpRight size={13} className="ml-auto" style={{ color: 'var(--text-mute)' }} />
            </div>
            <p className="mt-2 text-[12px]" style={{ color: 'var(--text-mute)' }}>
              See live CPU and memory per project: the real measure of what your hardware is spending.
            </p>
          </button>

          <div className="card p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck size={16} style={{ color: 'var(--green)' }} />
              <span className="text-[14px]" style={{ fontWeight: 600 }}>Quotas as cost control</span>
            </div>
            <p className="mt-2 text-[12px]" style={{ color: 'var(--text-mute)' }}>
              Open a project's Resources dialog from the Projects grid to cap its CPU cores and memory. Quotas are
              enforced at the container level.
            </p>
          </div>
        </div>
    </PageShell>
  );
}
