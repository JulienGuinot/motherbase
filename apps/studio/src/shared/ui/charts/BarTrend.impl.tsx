import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

// Themed bar chart for categorical/discrete series (e.g. row counts per table).
export default function BarTrend<T extends object>({
  data,
  xKey,
  yKey,
  color = 'var(--accent)',
  height = 180,
  format,
  labelFormat,
  horizontal,
  categoryWidth = 150,
}: {
  data: T[];
  xKey: keyof T & string;
  yKey: keyof T & string;
  color?: string;
  height?: number;
  format?: (v: number) => string;
  /** Formats the x value, for a time series whose raw x is an ISO timestamp. */
  labelFormat?: (x: string) => string;
  /**
   * Bars left to right with the categories down the side. Category names longer
   * than a few characters are unreadable at -30° along the bottom of a vertical
   * chart; `platform.webhook_deliveries` was rendering as `…ebhook_deliveries`.
   */
  horizontal?: boolean;
  /** Room for the category labels, when horizontal. */
  categoryWidth?: number;
}) {
  const tick = { fill: 'var(--text-mute)', fontSize: 10 };
  const tooltip = (
    <Tooltip
      contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
      labelStyle={{ color: 'var(--text-dim)' }}
      labelFormatter={labelFormat ? (label: unknown) => labelFormat(String(label)) : undefined}
      cursor={{ fill: 'var(--hover)' }}
      formatter={(v: unknown) => (format ? format(Number(v)) : String(v ?? ''))}
    />
  );

  if (horizontal) {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
          <XAxis
            type="number"
            tick={tick}
            tickFormatter={format ? v => format(Number(v)) : undefined}
            stroke="var(--border)"
          />
          <YAxis type="category" dataKey={xKey} tick={tick} stroke="var(--border)" width={categoryWidth} interval={0} />
          {tooltip}
          <Bar dataKey={yKey} fill={color} radius={[0, 3, 3, 0]} isAnimationActive={false} barSize={12} />
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        {labelFormat ? (
          // A time series: few, horizontal ticks, not one slanted label per bar.
          <XAxis dataKey={xKey} tick={tick} stroke="var(--border)" tickFormatter={labelFormat} minTickGap={32} />
        ) : (
          <XAxis dataKey={xKey} tick={tick} stroke="var(--border)" interval={0} angle={-30} textAnchor="end" height={54} />
        )}
        <YAxis tick={tick} tickFormatter={format ? v => format(Number(v)) : undefined} stroke="var(--border)" width={44} />
        {tooltip}
        <Bar dataKey={yKey} fill={color} radius={[3, 3, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}
