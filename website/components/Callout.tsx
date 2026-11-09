import Mascot, { type MascotName } from './Mascot'

type CalloutType = 'note' | 'warning' | 'flag'

// `flag` is the red one: a verified defect in the product, not advice about
// using it. It reads differently on purpose — the other two are guidance, this
// one is an admission.
const VARIANTS: Record<CalloutType, { label: string; tone: string; tint: number; edge: number; icon: MascotName }> = {
  note: { label: 'Note', tone: 'var(--accent)', tint: 0, edge: 0, icon: 'reading-advice' },
  warning: { label: 'Warning', tone: 'var(--amber)', tint: 9, edge: 35, icon: 'looking-map' },
  flag: { label: 'Known issue', tone: 'var(--red)', tint: 8, edge: 45, icon: 'bug' },
}

export function Callout({
  type = 'note',
  children,
}: {
  type?: CalloutType
  children: React.ReactNode
}) {
  const { label, tone, tint, edge, icon } = VARIANTS[type]
  return (
    <div
      style={{
        border: edge
          ? `1px solid color-mix(in srgb, ${tone} ${edge}%, var(--border))`
          : '1px solid var(--border)',
        background: tint
          ? `color-mix(in srgb, ${tone} ${tint}%, var(--surface))`
          : 'var(--surface)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-sm)',
        padding: '12px 16px',
        margin: '1rem 0',
        fontSize: 13,
        color: 'var(--text-dim)',
        lineHeight: 1.6,
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
      }}
    >
      <Mascot name={icon} size={34} style={{ marginTop: 1 }} />
      <div style={{ minWidth: 0 }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: tone,
            display: 'block',
            marginBottom: 6,
          }}
        >
          {label}
        </span>
        {children}
      </div>
    </div>
  )
}
