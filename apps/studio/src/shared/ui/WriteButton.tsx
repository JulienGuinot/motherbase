import type { ButtonHTMLAttributes } from 'react';
import { useProjectCapability } from '@/features/platform/hooks/usePlatformAccess';
import type { PlatformCapability } from '@/shared/lib/api';

/**
 * A button that disables itself when the signed-in operator's console role
 * cannot perform the write behind it.
 *
 * This is presentation, not authorization: the console already refuses the
 * request (`adminProxyCapability` maps every proxied admin route to a required
 * capability, and `admin-rbac-contract.unit.test.ts` proves no mutation is
 * reachable with a read-only capability). What this fixes is the console
 * offering an action it will then refuse, which reads as a bug rather than as a
 * permission.
 *
 * Centralised on purpose: a capability check copied into forty call sites is a
 * check that will be wrong in some of them.
 */
export function WriteButton({
  capability = 'content.write',
  disabled,
  title,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { capability?: PlatformCapability }) {
  const { editable, pending } = useProjectCapability(capability);
  // While the session is still loading, stay enabled: flickering a disabled
  // button on every page load is worse than a request that 403s.
  const blocked = !pending && !editable;

  return (
    <button
      {...rest}
      disabled={disabled || blocked}
      title={blocked ? `Your console role cannot ${capability.replace('.', ' ')} on this project.` : title}
    >
      {children}
    </button>
  );
}
