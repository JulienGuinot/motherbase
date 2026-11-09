import type { ComponentType, CSSProperties, ReactNode } from 'react';
import { Mascot, type MascotName } from '@/shared/ui/Mascot';

type Size = 'sm' | 'md';

// Every "nothing here yet" placeholder goes through this component so padding,
// colour and tone stay identical whether it sits in a list, a panel or a page.
// Pass an icon for the full-page variant; leave it out for inline list notes.
export function EmptyState({
  title,
  description,
  icon: Icon,
  mascot,
  action,
  size = 'sm',
  as: Tag = 'div',
  className = '',
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ComponentType<{ size?: number; style?: CSSProperties }>;
  /** Illustration instead of the icon chip. Wins over `icon` when both are given. */
  mascot?: MascotName;
  /** Primary call to action, rendered under the copy. */
  action?: ReactNode;
  /** `sm` for inline list placeholders, `md` for a panel or page taking the whole area. */
  size?: Size;
  as?: 'div' | 'li';
  className?: string;
  /** Extra content below the action (template pickers, secondary hints). */
  children?: ReactNode;
}) {
  const big = size === 'md' || !!Icon || !!mascot;
  return (
    <Tag className={`flex flex-col items-center justify-center gap-4 text-center ${big ? 'px-4 py-12' : 'px-4 py-9'} ${className}`}>
      {/* The octopus replaces the grey icon chip rather than joining it: two
          glyphs stacked over the same sentence is one glyph too many. */}
      {mascot ? <Mascot name={mascot} size={size === 'md' ? 104 : 76} /> : Icon && (
        <span
          className="flex items-center justify-center"
          style={{ width: 44, height: 44, borderRadius: 999, background: 'var(--surface-2)', border: '1px solid var(--border)' }}
        >
          <Icon size={20} style={{ color: 'var(--text-mute)' }} />
        </span>
      )}
      <div className="space-y-1.5">
        {/* A statement, not a caption, so an empty list never reads as one that
            failed to load: dim rather than mute, medium rather than normal, with
            the explanation underneath. */}
        <p
          className={big ? 'text-[15px]' : 'text-[13px]'}
          style={{ color: big ? 'var(--text)' : 'var(--text-dim)', fontWeight: big ? 600 : 500 }}
        >
          {title}
        </p>
        {description && (
          <p
            className={`mx-auto max-w-[380px] leading-relaxed ${big ? 'text-[12px]' : 'text-[11.5px]'}`}
            style={{ color: 'var(--text-mute)' }}
          >
            {description}
          </p>
        )}
      </div>
      {action}
      {children}
    </Tag>
  );
}
