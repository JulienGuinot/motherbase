import { AlertOctagon, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { Insight, InsightLevel } from '@/features/logs/lib/insights';

const META: Record<InsightLevel, { color: string; Icon: typeof Info }> = {
  critical: { color: 'var(--red)', Icon: AlertOctagon },
  warning: { color: 'var(--amber)', Icon: AlertTriangle },
  info: { color: 'var(--blue)', Icon: Info },
};

/**
 * The reading of the charts, in words. The numbers above answer "what is it",
 * this answers "and is that a problem", which is the whole reason anyone opens
 * an observability screen.
 */
export function InsightList({ insights }: { insights: Insight[] }) {
  const allClear = insights.length === 1 && insights[0]?.id === 'healthy';

  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between border-b hairline px-4 py-3">
        <span className="text-[13px]" style={{ fontWeight: 600 }}>Insights</span>
        <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
          derived from the selected window
        </span>
      </div>

      <ul>
        {insights.map(insight => {
          const { color, Icon } = META[insight.level];
          const HealthyIcon = allClear ? CheckCircle2 : Icon;
          const tone = allClear ? 'var(--green)' : color;

          return (
            <li key={insight.id} className="flex items-start gap-3 border-b hairline px-4 py-3 last:border-b-0">
              <HealthyIcon size={15} style={{ color: tone, flexShrink: 0, marginTop: 1 }} />
              <div className="min-w-0">
                <div className="text-[13px]" style={{ color: 'var(--text)', fontWeight: 550 }}>{insight.title}</div>
                <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-dim)' }}>{insight.detail}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
