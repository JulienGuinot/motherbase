export function LevelStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="text-right">
      <div className="label">{label}</div>
      <div className="tabular-nums text-[28px]" style={{ color, fontWeight: 600, letterSpacing: '-0.01em' }}>{value}</div>
    </div>
  );
}
