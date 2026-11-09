import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface Props {
  value: string;
  /** Show a text label next to the icon. */
  label?: string;
  /** Short toast/inline confirmation; defaults to "Copied". */
  className?: string;
  title?: string;
}

/**
 * One-click copy-to-clipboard button. Falls back to a hidden textarea when the
 * async clipboard API is unavailable (insecure origins, older browsers).
 */
export default function CopyButton({ value, label, className, title }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={title ?? 'Copy to clipboard'}
      className={className ?? 'btn btn-ghost'}
      style={{ color: copied ? 'var(--green)' : undefined }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {label && <span>{copied ? 'Copied' : label}</span>}
    </button>
  );
}
