import Image from 'next/image'
import type { CSSProperties } from 'react'

// The art lives in public/mascot/<name>.png: 256px PNGs with an alpha channel,
// so one file works on both themes. Names mirror the filenames on purpose —
// a typo becomes a type error instead of a broken image at runtime.
export const MASCOTS = [
  'bucket',
  'bug',
  'coding',
  'coding-deploying',
  'config',
  'db-backup',
  'deploy',
  'drinking-coffee',
  'flying-right',
  'happy',
  'hugging-postgres',
  'idea',
  'integrations',
  'listening-music',
  'listening-sonar',
  'log-inspector',
  'logo',
  'looking-map',
  'plug-cable',
  'presenting-chart',
  'reading-advice',
  'shield-keylock',
  'sleeping',
  'smirking',
  'smirk-thumbup',
  'success',
  'sunglasses',
  'update',
  'webhook',
] as const

export type MascotName = (typeof MASCOTS)[number]

interface MascotProps {
  name: MascotName
  size?: number
  /** Leave empty for decoration next to text that already says the same thing. */
  alt?: string
  className?: string
  style?: CSSProperties
  priority?: boolean
}

export default function Mascot({ name, size = 40, alt = '', className, style, priority }: MascotProps) {
  return (
    <Image
      src={`/mascot/${name}.png`}
      alt={alt}
      width={size}
      height={size}
      priority={priority}
      aria-hidden={alt === '' || undefined}
      className={className}
      // The source art isn't square; contain keeps every mascot on the same
      // optical baseline without cropping a tentacle off.
      style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0, ...style }}
    />
  )
}
