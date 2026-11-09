import { useState } from 'react';
import { BASE_PATH } from '@/shared/lib/project';
import { BRAND_MARKS } from '@/shared/ui/brand-marks';

interface BrandLogoProps {
  brand?: string;
  label: string;
  size?: number;
  className?: string;
}

export function BrandLogo({ brand, label, size = 32, className = '' }: BrandLogoProps) {
  const [failedBrand, setFailedBrand] = useState<string>();

  // Inline marks first: they cover the providers we ship no bitmap for, and
  // they cost no extra request at the 13/22/44px sizes the console uses.
  const mark = brand ? BRAND_MARKS[brand] : undefined;
  if (mark) {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        role="img"
        aria-hidden
        className={`block shrink-0 ${className}`}
      >
        <title>{`${label} logo`}</title>
        {mark}
      </svg>
    );
  }

  if (!brand || failedBrand === brand) {
    return (
      <span
        aria-hidden
        className={`inline-flex shrink-0 items-center justify-center font-semibold ${className}`}
        style={{ width: size, height: size, fontSize: Math.max(9, size * 0.34), color: 'var(--text-mute)' }}
      >
        {initials(label)}
      </span>
    );
  }

  return (
    <img
      src={`${BASE_PATH}/provider-logos/${brand}.png`}
      alt=""
      aria-hidden
      draggable={false}
      className={`block shrink-0 object-contain ${className}`}
      style={{ width: size, height: size }}
      title={`${label} logo`}
      onError={() => setFailedBrand(brand)}
    />
  );
}

export function initials(value: string): string {
  const words = value.replace(/[-_]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  // "PostHog" and "Postmark" both collapse to "PO" on a plain slice; the inner
  // capital tells them apart when a provider name is one CamelCase word.
  const caps = value.match(/[A-Z]/g);
  if (caps && caps.length > 1) return `${caps[0]}${caps[1]}`;
  return value.slice(0, 2).toUpperCase();
}
