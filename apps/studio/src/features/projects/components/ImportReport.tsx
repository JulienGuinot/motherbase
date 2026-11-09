import { type ReactNode, useState } from 'react';
import { ArrowUpRight, ChevronRight, CircleAlert, CircleCheck, Info, KeyRound, PlugZap, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import type { SupabaseImportSummary } from '@/shared/lib/api';
import { projectPath } from '@/shared/lib/project';
import { Badge, StatusDot, type Tone } from '@/shared/ui/Badge';
import CopyButton from '@/shared/ui/CopyButton';

// What the operator reads after an import: one row per section, each carrying
// its own count and its own problems, folded away until asked for, so the line
// that says WHICH section broke never scrolls away under repeated errors.

interface ReportLine {
  key: string;
  label: string;
  tone: Tone;
  /** The one-line result: counts, or why there is none. */
  detail: string;
  /** This section's failures, verbatim. */
  issues: string[];
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * A section's tone: red when it failed outright, amber when it ran but left
 * something behind (skipped rows, functions held back), green when it
 * did all of what was asked, grey when it was not asked for at all.
 */
function reportLines(summary: SupabaseImportSummary): ReportLine[] {
  const lines: ReportLine[] = [
    {
      key: 'schema',
      label: 'Schema + RLS',
      tone: summary.schema.applied ? 'success' : summary.schema.error ? 'danger' : 'neutral',
      detail: summary.schema.applied ? 'applied' : summary.schema.error ? 'failed' : 'not requested',
      issues: [summary.schema.error, summary.schema.warnings].filter((x): x is string => Boolean(x)),
    },
    {
      key: 'data',
      label: 'Table data',
      tone: summary.data.applied ? 'success' : summary.data.includedInDump ? 'danger' : 'neutral',
      detail: summary.data.applied ? 'applied' : summary.data.includedInDump ? 'failed' : 'not requested',
      issues: summary.data.error ? [summary.data.error] : [],
    },
    {
      key: 'auth',
      label: 'Auth users',
      tone: summary.auth.errors.length > 0 ? 'danger' : summary.auth.skipped > 0 ? 'warn' : 'success',
      detail: [
        `${summary.auth.imported} imported`,
        summary.auth.skipped > 0 ? `${summary.auth.skipped} skipped` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      issues: summary.auth.errors,
    },
    {
      key: 'storage',
      label: 'Buckets + files',
      tone: summary.storage.errors.length > 0 ? 'danger' : summary.storage.skipped > 0 ? 'warn' : 'success',
      detail: [
        plural(summary.storage.buckets, 'bucket'),
        `${plural(summary.storage.objects, 'file')} copied`,
        summary.storage.skipped > 0 ? `${summary.storage.skipped} skipped` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      issues: summary.storage.errors,
    },
    {
      key: 'edge',
      label: 'Edge functions',
      tone: summary.edgeFunctions.errors.length > 0
        ? 'danger'
        : summary.edgeFunctions.needsPorting > 0
          ? 'warn'
          : 'success',
      detail: [
        `${summary.edgeFunctions.imported} imported`,
        `${summary.edgeFunctions.enabled} enabled`,
        summary.edgeFunctions.needsPorting > 0 ? `${summary.edgeFunctions.needsPorting} held back` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      issues: summary.edgeFunctions.errors,
    },
    {
      key: 'secrets',
      label: 'Secrets',
      tone: summary.secrets.errors.length > 0 ? 'danger' : summary.secrets.skipped > 0 ? 'warn' : 'success',
      detail: [
        `${summary.secrets.imported} imported`,
        summary.secrets.skipped > 0 ? `${summary.secrets.skipped} skipped` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      issues: summary.secrets.errors,
    },
  ];

  if (summary.verification) {
    const { valid, checked, errors } = summary.verification;
    lines.push({
      key: 'verification',
      label: 'Verification',
      tone: valid ? 'success' : 'danger',
      detail: valid
        ? `passed · ${plural(checked.tables, 'table')}, ${checked.constraints} constraints, ${checked.policies} policies`
        : `${plural(errors.length, 'issue')}`,
      issues: errors,
    });
  }

  return lines;
}

/** The same report as text, for a ticket or a paste back to whoever asked. */
function asText(summary: SupabaseImportSummary): string {
  const rows = reportLines(summary).map(line => {
    const issues = line.issues.map(issue => `    - ${issue}`).join('\n');
    return `- ${line.label}: ${line.detail}${issues ? `\n${issues}` : ''}`;
  });
  const notes = summary.notes.map(note => `- ${note}`);
  const todo = [
    summary.secrets.undisclosed?.length
      ? `- set by hand (Supabase discloses no values): ${summary.secrets.undisclosed.join(', ')}`
      : '',
    summary.edgeFunctions.disabled?.length
      ? `- imported disabled: ${summary.edgeFunctions.disabled.join(', ')}`
      : '',
  ].filter(Boolean);
  return [
    `Supabase import: ${summary.status}`,
    ...rows,
    ...(todo.length > 0 ? ['', 'Still to do:', ...todo] : []),
    ...(notes.length > 0 ? ['', 'Notes:', ...notes] : []),
  ].join('\n');
}

export function ImportReport({
  summary,
  projectId,
}: {
  summary: SupabaseImportSummary;
  /** Enables the deep links in the follow-up steps. Omit and they render as text. */
  projectId?: string;
}) {
  const lines = reportLines(summary);
  const failedCount = lines.reduce((total, line) => total + line.issues.length, 0);
  const tone = summary.status === 'success' ? 'var(--green)' : summary.status === 'partial' ? 'var(--amber)' : 'var(--red)';

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-2 text-[13px]" style={{ color: tone, fontWeight: 600 }}>
          {summary.status === 'success' ? <CircleCheck size={16} /> : <CircleAlert size={16} />}
          Import {summary.status === 'success' ? 'complete' : summary.status === 'partial' ? 'partially complete' : 'failed'}
        </span>
        {failedCount > 0 && <Badge tone="danger">{plural(failedCount, 'problem')}</Badge>}
        <CopyButton value={asText(summary)} label="Copy report" className="btn btn-ghost ml-auto text-[11px]" />
      </div>

      <div className="rounded-md border hairline" style={{ background: 'var(--surface-2)' }}>
        {lines.map(line => (
          <ReportRow key={line.key} line={line} />
        ))}
      </div>

      <NextSteps summary={summary} projectId={projectId} />

      {summary.notes.length > 0 && <NotesBlock notes={summary.notes} />}
    </div>
  );
}

function ReportRow({ line }: { line: ReportLine }) {
  const [open, setOpen] = useState(false);
  const hasIssues = line.issues.length > 0;

  const row = (
    <>
      <StatusDot tone={line.tone} size={8} />
      <span className="min-w-0 truncate text-[12px]" style={{ color: 'var(--text-dim)', fontWeight: 500 }}>
        {line.label}
      </span>
      <span className="ml-auto truncate text-[12px]" style={{ color: 'var(--text-mute)' }}>
        {line.detail}
      </span>
      {hasIssues && (
        <>
          <Badge tone="danger">{line.issues.length}</Badge>
          <ChevronRight
            size={13}
            style={{ color: 'var(--text-mute)', transform: open ? 'rotate(90deg)' : undefined }}
          />
        </>
      )}
    </>
  );

  return (
    <div className="border-b hairline last:border-b-0">
      {hasIssues ? (
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
          className="nav-item flex w-full items-center gap-2 px-3 py-2 text-left"
        >
          {row}
        </button>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2">{row}</div>
      )}

      {open && (
        <ul className="max-h-48 space-y-1.5 overflow-y-auto px-3 pb-2.5 pt-0.5">
          {line.issues.map((issue, i) => (
            <li
              key={i}
              className="flex items-start gap-1.5 break-words font-mono text-[11px] leading-4"
              style={{ color: 'var(--red)' }}
            >
              <TriangleAlert size={11} className="mt-0.5 shrink-0" />
              <span className="min-w-0">{issue}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The importer's notes: what it rewrote, what it could not, what to look at
 * before trusting the result. Folded, because on a real project there are a
 * dozen and they would bury the counts above them.
 */
function NotesBlock({ notes }: { notes: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border hairline" style={{ background: 'var(--surface-2)' }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="nav-item flex w-full items-center gap-2 px-3 py-2 text-left text-[12px]"
        style={{ color: 'var(--text-dim)' }}
      >
        <Info size={13} style={{ color: 'var(--blue)' }} />
        What the importer changed and what to check ({notes.length})
        <ChevronRight
          size={13}
          className="ml-auto"
          style={{ color: 'var(--text-mute)', transform: open ? 'rotate(90deg)' : undefined }}
        />
      </button>
      {open && (
        <ul className="max-h-60 space-y-2 overflow-y-auto border-t hairline px-3 py-2.5">
          {notes.map((note, i) => (
            <li key={i} className="text-[11px] leading-4" style={{ color: 'var(--text-mute)' }}>
              {note}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The work the import could not do for you.
 *
 * Two things always land on the operator, and both used to be sentences inside
 * the notes: secrets Supabase refuses to disclose, and functions held back as
 * disabled. Each one is a list with the page that fixes it one click away.
 */
function NextSteps({ summary, projectId }: { summary: SupabaseImportSummary; projectId?: string }) {
  const undisclosed = summary.secrets.undisclosed ?? [];
  const disabled = summary.edgeFunctions.disabled ?? [];
  if (undisclosed.length === 0 && disabled.length === 0) return null;

  const edgePath = projectId ? projectPath('/edge-functions', projectId) : undefined;
  const secretsPath = edgePath ? `${edgePath}?panel=secrets` : undefined;

  return (
    <div className="rounded-md border hairline" style={{ background: 'var(--surface-2)' }}>
      <div className="border-b hairline px-3 py-2 text-[12px]" style={{ color: 'var(--text-dim)', fontWeight: 600 }}>
        Before these functions can run
      </div>

      {undisclosed.length > 0 && (
        <Step
          icon={<KeyRound size={13} style={{ color: 'var(--amber)' }} />}
          title={`Set ${plural(undisclosed.length, 'secret')} by hand`}
          hint="Supabase returns a hash of each value, never the value, so these came across as names only."
          path={secretsPath}
          linkLabel="Open Edge functions → Secrets"
          items={undisclosed}
          copyValue={undisclosed.join('\n')}
          copyLabel="Copy names"
        />
      )}

      {disabled.length > 0 && (
        <Step
          icon={<PlugZap size={13} style={{ color: 'var(--amber)' }} />}
          title={`${plural(disabled.length, 'function')} imported disabled`}
          hint="Their source is here untouched. Each one failed the same deploy check the deploy button runs."
          path={edgePath}
          linkLabel="Open Edge functions"
          items={disabled}
        />
      )}

      {/* This panel is read once and closed, and the work in it is not done yet.
          The same three gaps are re-derived from what is stored on every Advisor
          scan, so say where they live before this modal takes them away. */}
      <div className="px-3 py-2 text-[11px] leading-4" style={{ color: 'var(--text-mute)' }}>
        Nothing here is lost when you close this: Advisor re-checks the stored functions and secrets on every scan
        and lists whatever is still outstanding.
        {projectId && (
          <>
            {' '}
            <Link href={projectPath('/advisor', projectId)} className="hover:underline" style={{ color: 'var(--accent)' }}>
              Open Advisor
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

function Step({
  icon,
  title,
  hint,
  items,
  path,
  linkLabel,
  copyValue,
  copyLabel,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  items: string[];
  path?: string;
  linkLabel?: string;
  copyValue?: string;
  copyLabel?: string;
}) {
  return (
    <div className="border-b hairline px-3 py-2.5 last:border-b-0">
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-[12px]" style={{ color: 'var(--text)', fontWeight: 500 }}>{title}</span>
        {copyValue && <CopyButton value={copyValue} label={copyLabel} className="btn btn-ghost ml-auto text-[11px]" />}
      </div>
      <p className="mt-1 text-[11px] leading-4" style={{ color: 'var(--text-mute)' }}>{hint}</p>

      <ul className="mt-1.5 flex flex-wrap gap-1">
        {items.map(item => (
          <li key={item} className="chip font-mono text-[11px]" style={{ color: 'var(--text-dim)' }}>
            {item}
          </li>
        ))}
      </ul>

      {path && linkLabel && (
        <Link
          href={path}
          className="mt-1.5 inline-flex items-center gap-1 text-[11px] hover:underline"
          style={{ color: 'var(--accent)' }}
        >
          {linkLabel}
          <ArrowUpRight size={11} />
        </Link>
      )}
    </div>
  );
}

export default ImportReport;
