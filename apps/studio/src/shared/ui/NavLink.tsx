'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { CSSProperties, ReactNode } from 'react';

interface RenderArgs {
  isActive: boolean;
}

/**
 * A link that knows whether it points at the current route. Replaces
 * react-router's NavLink: next/link has no active state of its own, and the
 * three navigations in this app all need one.
 *
 * `end` matches the exact path only, for a parent entry that would otherwise
 * stay lit on every child route.
 */
export function NavLink({
  href,
  end = false,
  className,
  style,
  children,
  ...rest
}: {
  href: string;
  end?: boolean;
  className?: string | ((args: RenderArgs) => string);
  style?: CSSProperties | ((args: RenderArgs) => CSSProperties);
  children: ReactNode | ((args: RenderArgs) => ReactNode);
} & Omit<React.ComponentProps<typeof Link>, 'href' | 'className' | 'style' | 'children'>) {
  const pathname = usePathname() ?? '';
  const isActive = end ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  const args: RenderArgs = { isActive };

  return (
    <Link
      href={href}
      className={typeof className === 'function' ? className(args) : className}
      style={typeof style === 'function' ? style(args) : style}
      {...rest}
    >
      {typeof children === 'function' ? children(args) : children}
    </Link>
  );
}

export default NavLink;
