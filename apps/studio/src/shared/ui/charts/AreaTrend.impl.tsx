import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

// Themed area chart. Colors come from CSS vars so it tracks light/dark. `data`
// is an array of points; `xKey`/`yKey` select the fields; `color` is a CSS var.
export default function AreaTrend<T extends object>({
  data,
  xKey,
  yKey,
  color = 'var(--accent)',
  height = 180,
  format,
  labelFormat,
}: {
  data: T[];
  xKey: keyof T & string;
  yKey: keyof T & string;
  color?: string;
  height?: number;
  format?: (v: number) => string;
  labelFormat?: (v: string) => string;
}) {
  const gradId = `grad-${yKey}`;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey={xKey}
          tick={{ fill: 'var(--text-mute)', fontSize: 10 }}
          tickFormatter={labelFormat}
          stroke="var(--border)"
          minTickGap={40}
        />
        <YAxis
          tick={{ fill: 'var(--text-mute)', fontSize: 10 }}
          tickFormatter={format ? (v => format(Number(v))) : undefined}
          stroke="var(--border)"
          width={44}
        />
        <Tooltip
          contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
          labelStyle={{ color: 'var(--text-dim)' }}
          labelFormatter={labelFormat}
          formatter={(v: unknown) => (format ? format(Number(v)) : String(v ?? ''))}
        />
        <Area type="monotone" dataKey={yKey} stroke={color} strokeWidth={2} fill={`url(#${gradId})`} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
