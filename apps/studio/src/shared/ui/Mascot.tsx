import type { CSSProperties } from 'react';
import { BASE_PATH } from '@/shared/lib/project';

// The octopus. One illustration set, one component, one place that knows the
// file names, so a missing PNG is a type error here instead of a broken image
// in production. Files live in public/mascot/<name>.png; Mascot.test.ts asserts
// this list and that directory stay in sync.
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
  'smirk-thumbup',
  'smirking',
  'success',
  'sunglasses',
  'update',
  'webhook',
] as const;

export type MascotName = (typeof MASCOTS)[number];

export function Mascot({
  name,
  size = 96,
  /** Gentle idle bob. Reserve it for hero-sized art; a list placeholder that
   *  moves is a list placeholder that distracts. */
  float = false,
  className = '',
  style,
}: {
  name: MascotName;
  size?: number;
  float?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <img
      src={`${BASE_PATH}/mascot/${name}.png`}
      // Decorative in every current placement: the copy next to it always says
      // what the state is, so a description here would only be read twice.
      alt=""
      aria-hidden
      draggable={false}
      width={size}
      height={size}
      className={`block shrink-0 object-contain ${float ? 'mascot-float' : ''} ${className}`}
      style={{ width: size, height: size, ...style }}
    />
  );
}
