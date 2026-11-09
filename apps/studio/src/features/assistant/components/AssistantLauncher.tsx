import type { ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import { ThinkingOrb } from '@/shared/ui/ThinkingOrb';

/**
 * The closed dock. Small screens have one floating control, the navigation
 * pill, so there the launcher goes inside it (`mobileNav`) rather than beside it.
 */
export function AssistantLauncher({
  streaming,
  onOpen,
  mobileNav,
}: {
  streaming: boolean;
  onOpen: () => void;
  mobileNav?: (launcher: ReactNode) => ReactNode;
}) {
  const launcherProps = {
    type: 'button',
    'aria-label': streaming ? 'Open the assistant, which is answering' : 'Open the assistant',
    onClick: onOpen,
  } as const;
  // Closed, the dock is the only thing that can report that an answer is
  // still being written; the sparkle alone looks idle.
  const label = (
    <>
      {streaming ? <ThinkingOrb size={14} /> : <Sparkles size={14} />}
      Assistant
    </>
  );
  return (
    <>
      <button
        {...launcherProps}
        className={`fixed bottom-4 right-4 z-40 items-center gap-2 rounded-full border px-3 py-2 text-[12px] shadow ${mobileNav ? 'hidden md:flex' : 'flex'}`}
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        {label}
      </button>
      {mobileNav?.(
        <button {...launcherProps} className="flex items-center gap-2 px-4 py-2.5 text-[13px] font-medium" style={{ color: 'var(--text)' }}>
          {label}
        </button>,
      )}
    </>
  );
}
