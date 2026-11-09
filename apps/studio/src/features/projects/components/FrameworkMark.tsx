import { Globe } from 'lucide-react';
import type { Framework } from '@/shared/lib/snippets';

/**
 * Simplified framework marks, drawn inline. A handful of paths beats an icon
 * dependency or 8 more PNGs in public/, and they follow the brand colours in
 * both themes because they carry their own fills.
 */
export function FrameworkMark({ framework, size = 16 }: { framework: Framework; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true } as const;

  switch (framework) {
    case 'react':
      return (
        <svg {...common} fill="none" stroke="#61DAFB" strokeWidth="1.2">
          <circle cx="12" cy="12" r="2" fill="#61DAFB" stroke="none" />
          <ellipse cx="12" cy="12" rx="10" ry="4" />
          <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" />
          <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" />
        </svg>
      );
    case 'next':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="11" fill="currentColor" />
          <path d="M8 17V7l9 12" stroke="var(--surface)" strokeWidth="1.6" fill="none" />
          <path d="M15.5 7v7" stroke="var(--surface)" strokeWidth="1.6" />
        </svg>
      );
    case 'vue':
      return (
        <svg {...common}>
          <path d="M1 3h4.5L12 14 18.5 3H23L12 21z" fill="#41B883" />
          <path d="M6 3h3l3 5 3-5h3l-6 10z" fill="#35495E" />
        </svg>
      );
    case 'nuxt':
      return (
        <svg {...common}>
          <path d="M13 20 6.5 8 0 20z" fill="#00DC82" />
          <path d="M24 20 15.5 5 11 12.5 15.5 20z" fill="#0f7f56" />
        </svg>
      );
    case 'sveltekit':
      return (
        <svg {...common}>
          <rect x="1" y="1" width="22" height="22" rx="5" fill="#FF3E00" />
          <text x="12" y="17" textAnchor="middle" fontSize="13" fontWeight="700" fill="#fff">S</text>
        </svg>
      );
    case 'expo':
      return (
        <svg {...common}>
          <rect x="1" y="1" width="22" height="22" rx="5" fill="currentColor" />
          <path d="M12 6.5 19 17.5h-2.4L12 10.4 7.4 17.5H5z" fill="var(--surface)" />
        </svg>
      );
    case 'js':
      return (
        <svg {...common}>
          <rect x="1" y="1" width="22" height="22" rx="3" fill="#F7DF1E" />
          <text x="12" y="17" textAnchor="middle" fontSize="11" fontWeight="700" fill="#000">JS</text>
        </svg>
      );
    case 'direct':
      return <Globe size={size} />;
  }
}
