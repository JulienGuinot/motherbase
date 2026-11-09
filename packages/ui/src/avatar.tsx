'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { User } from '@motherbase/client';
import { Blobatar } from 'blobatar/react';
import { classes } from './shared.js';

export type AvatarUser = Partial<Pick<User, 'name' | 'email' | 'image' | 'imageUrl' | 'user_metadata'>>;

export interface UserAvatarProps {
  user?: AvatarUser | null;
  /** Image URL. Overrides the user's own; `null` skips the image and shows the fallback. */
  src?: string | null;
  /** Seed for the generated fallback. Defaults to the user's name, then email. */
  name?: string;
  size?: number;
  alt?: string;
  /** Replaces the generated blobatar when there is no image or it fails to load. */
  fallback?: ReactNode | ((name: string) => ReactNode);
  className?: string;
}

/** The image the user picked, wherever the server stored it. */
export function avatarSrc(user?: AvatarUser | null): string | undefined {
  return user?.image || user?.user_metadata?.image || user?.imageUrl || undefined;
}

export function UserAvatar({ user, src, name, size = 28, alt = '', fallback, className }: UserAvatarProps) {
  const url = src === undefined ? avatarSrc(user) : src;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const seed = name || user?.name || user?.email || 'user';

  function renderFallback() {
    if (fallback === undefined) return <Blobatar name={seed} size={size} alt={alt} />;
    return typeof fallback === 'function' ? fallback(seed) : fallback;
  }

  return <span className={classes('mbui-avatar', className)} style={{ width: size, height: size }}>
    {url && url !== failedUrl
      ? <img className="mbui-avatar-photo" src={url} alt={alt} width={size} height={size} onError={() => setFailedUrl(url)} />
      : renderFallback()}
  </span>;
}
