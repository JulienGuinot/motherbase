import { ExternalLink } from 'lucide-react';

/**
 * The dashboard page a credential is created on, one click away.
 *
 * Each import field used to name its page in prose, which left the operator
 * retyping a URL into another tab to copy a value back. Same text, clickable.
 */
export default function SupabaseDashboardLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      className="mt-1 inline-flex items-center gap-1 text-[11px] hover:underline"
      style={{ color: 'var(--accent)' }}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      // The field's <label> wraps this; a click here must not focus the input.
      onClick={e => e.stopPropagation()}
    >
      {label}
      <ExternalLink size={11} className="shrink-0" />
    </a>
  );
}
