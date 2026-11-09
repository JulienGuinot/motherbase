import { useState } from 'react';
import { X, Loader2, CircleAlert, TriangleAlert } from 'lucide-react';
import { platform, type SupabaseImportInclude, type SupabaseImportPreview, type SupabaseImportSummary } from '@/shared/lib/api';
import { getErrorMessage } from '@/shared/lib/errors';
import SupabaseLogo from '@/shared/ui/SupabaseLogo';
import { Modal } from '@/shared/ui/Modal';
import {
  SUPABASE_CONN_HINT,
  SUPABASE_CONN_PLACEHOLDER,
  SUPABASE_MANAGEMENT_TOKEN_HINT,
  SUPABASE_SERVICE_KEY_HINT,
  SUPABASE_TOKENS_URL,
  inspectSupabaseConn,
  supabaseApiKeysUrl,
  supabaseConnIsUsable,
  supabaseConnectUrl,
} from '../supabase-conn';
import SupabaseDashboardLink from './SupabaseDashboardLink';
import { ImportReport } from './ImportReport';

// Self-contained "import an existing Supabase project" flow for a project that
// already exists (the blank-project entry point). Credentials, then a dry-run
// preview of counts, then the real import with a per-section summary.
// Reuses the same per-project admin endpoints CreateProject uses at provision.

// Order matters: this is also the order the sections run in on the server.
const SECTIONS: { key: keyof SupabaseImportInclude; label: string; needs?: 'service' | 'token' }[] = [
  { key: 'schema', label: 'Schema + RLS' },
  { key: 'data', label: 'Table data' },
  { key: 'auth', label: 'Auth users' },
  { key: 'storage', label: 'Buckets + files', needs: 'service' },
  { key: 'edgeFunctions', label: 'Edge functions', needs: 'token' },
  { key: 'secrets', label: 'Secrets', needs: 'token' },
];

export function SupabaseImportModal({
  projectId,
  onClose,
  onImported,
}: {
  projectId: string;
  onClose: () => void;
  onImported?: () => void;
}) {
  const [conn, setConn] = useState('');
  const [serviceRoleKey, setServiceRoleKey] = useState('');
  const [managementToken, setManagementToken] = useState('');
  const [include, setInclude] = useState<Required<SupabaseImportInclude>>({
    schema: true,
    data: true,
    auth: true,
    storage: true,
    edgeFunctions: true,
    secrets: true,
  });
  const [preview, setPreview] = useState<SupabaseImportPreview | null>(null);
  const [summary, setSummary] = useState<SupabaseImportSummary | null>(null);
  const [busy, setBusy] = useState<false | 'preview' | 'import'>(false);
  const [error, setError] = useState('');

  const connIssues = inspectSupabaseConn(conn);
  const canRun = supabaseConnIsUsable(conn) && !busy;

  // A section whose credential is missing still runs; it just reports what it
  // could not reach. Saying so here is cheaper than finding out in the summary,
  // but only once the operator has started: two amber lines on an untouched
  // form read as errors rather than as guidance.
  const started = conn.trim().length > 0;
  const missingService = started && include.storage && !serviceRoleKey.trim();
  const missingToken = started && (include.edgeFunctions || include.secrets) && !managementToken.trim();

  const body = () => ({
    connectionString: conn,
    include,
    serviceRoleKey: serviceRoleKey.trim() || undefined,
    managementToken: managementToken.trim() || undefined,
  });

  async function runPreview() {
    setBusy('preview');
    setError('');
    try {
      setPreview(await platform.importSupabasePreview(projectId, body()));
    } catch (e) {
      setError(getErrorMessage(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    setBusy('import');
    setError('');
    try {
      const result = await platform.importSupabase(projectId, body());
      setSummary(result);
      onImported?.();
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} width={summary ? '680px' : '560px'} className="overflow-hidden" ariaLabel="Import from Supabase">
      <>
        <div className="flex shrink-0 items-center gap-2.5 border-b hairline px-5 py-4">
          <SupabaseLogo size={20} />
          <div className="min-w-0">
            <h2 className="text-[14px]" style={{ color: 'var(--text)', fontWeight: 600 }}>Import from Supabase</h2>
            <p className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
              Schema, data, RLS policies, auth users, storage, edge functions and secrets
            </p>
          </div>
          <button onClick={onClose} className="ml-auto rounded p-1" style={{ color: 'var(--text-mute)' }} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {summary ? (
            <ImportReport summary={summary} projectId={projectId} />
          ) : (
            <>
              <label className="block">
                <span className="text-[12px]" style={{ color: 'var(--text-dim)', fontWeight: 500 }}>
                  Supabase session pooler URI 🔒
                </span>
                <input
                  className="input mt-1 w-full font-mono text-[12px]"
                  type="password"
                  placeholder={SUPABASE_CONN_PLACEHOLDER}
                  value={conn}
                  onChange={e => { setConn(e.target.value); setPreview(null); }}
                  disabled={!!busy}
                />
                <span className="mt-1 block text-[11px]" style={{ color: 'var(--text-mute)' }}>
                  {SUPABASE_CONN_HINT}
                </span>
                <SupabaseDashboardLink href={supabaseConnectUrl(conn)} label="Open Supabase → Connect" />
                <span className="mt-1 block font-mono text-[10px] leading-4" style={{ color: 'var(--text-mute)' }}>
                  {SUPABASE_CONN_PLACEHOLDER}
                </span>
                {connIssues.map((issue, i) => (
                  <span
                    key={i}
                    className="mt-1 flex items-start gap-1.5 text-[11px]"
                    style={{ color: issue.level === 'error' ? 'var(--red)' : 'var(--amber)' }}
                  >
                    <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                    <span className="min-w-0">{issue.message}</span>
                  </span>
                ))}
              </label>

              <SecretField
                label="service_role key 🔒"
                optional
                hint={SUPABASE_SERVICE_KEY_HINT}
                link={{ href: supabaseApiKeysUrl(conn), label: 'Open Supabase → API keys' }}
                placeholder="eyJhbGciOi…"
                value={serviceRoleKey}
                disabled={!!busy}
                warn={missingService ? 'Without it the buckets are created but their files are not copied.' : undefined}
                onChange={value => { setServiceRoleKey(value); setPreview(null); }}
              />

              <SecretField
                label="Personal access token 🔒"
                optional
                hint={SUPABASE_MANAGEMENT_TOKEN_HINT}
                link={{ href: SUPABASE_TOKENS_URL, label: 'Open Supabase → Generate new token' }}
                placeholder="sbp_…"
                value={managementToken}
                disabled={!!busy}
                warn={missingToken ? 'Without it edge functions and secrets cannot be read: they live outside the database.' : undefined}
                onChange={value => { setManagementToken(value); setPreview(null); }}
              />

              <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                {SECTIONS.map(section => (
                  <label
                    key={section.key}
                    className="flex items-center gap-2 text-[12px]"
                    style={{ color: 'var(--text-dim)' }}
                  >
                    <input
                      type="checkbox"
                      checked={include[section.key]}
                      disabled={!!busy}
                      onChange={e => {
                        setInclude(s => ({ ...s, [section.key]: e.target.checked }));
                        setPreview(null);
                      }}
                    />
                    {section.label}
                  </label>
                ))}
              </div>

              {preview && <ImportPreviewView preview={preview} />}

              {error && (
                <div className="flex items-start gap-2 rounded-md p-3 text-[12px]" style={{ background: 'color-mix(in srgb, var(--red) 12%, transparent)', color: 'var(--red)' }}>
                  <CircleAlert size={14} className="mt-0.5 shrink-0" />
                  <span className="min-w-0 break-words">{error}</span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex shrink-0 gap-3 border-t hairline px-5 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          {summary ? (
            <button className="btn btn-primary ml-auto" onClick={onClose}>Done</button>
          ) : (
            <>
              <button className="btn" onClick={runPreview} disabled={!canRun}>
                {busy === 'preview' ? <Loader2 size={13} className="animate-spin" /> : null} Preview
              </button>
              <button className="btn btn-primary ml-auto" onClick={runImport} disabled={!canRun}>
                {busy === 'import' ? <Loader2 size={13} className="animate-spin" /> : null} Import now
              </button>
            </>
          )}
        </div>
      </>
    </Modal>
  );
}

/** A masked credential input with a hint and an optional "you'll miss X" warning. */
function SecretField({
  label,
  hint,
  placeholder,
  value,
  onChange,
  disabled,
  optional,
  warn,
  link,
}: {
  label: string;
  hint: string;
  link?: { href: string; label: string };
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  optional?: boolean;
  warn?: string;
}) {
  return (
    <label className="block">
      <span className="text-[12px]" style={{ color: 'var(--text-dim)', fontWeight: 500 }}>
        {label}
        {optional && <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}> · optional</span>}
      </span>
      <input
        className="input mt-1 w-full font-mono text-[12px]"
        type="password"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
      />
      <span className="mt-1 block text-[11px]" style={{ color: 'var(--text-mute)' }}>{hint}</span>
      {link && <SupabaseDashboardLink href={link.href} label={link.label} />}
      {warn && (
        <span className="mt-1 flex items-start gap-1.5 text-[11px]" style={{ color: 'var(--amber)' }}>
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{warn}</span>
        </span>
      )}
    </label>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function ImportPreviewView({ preview }: { preview: SupabaseImportPreview }) {
  const objects = preview.buckets.reduce((total, b) => total + b.objects, 0);
  const bytes = preview.buckets.reduce((total, b) => total + b.bytes, 0);
  return (
    <div className="rounded-md border hairline p-3 text-[12px]" style={{ background: 'var(--surface-2)' }}>
      <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1" style={{ color: 'var(--text-dim)' }}>
        <span><b>{preview.tables.length}</b> tables</span>
        <span><b>{preview.tables.reduce((s, t) => s + t.rows, 0).toLocaleString()}</b> rows</span>
        <span><b>{preview.policies}</b> policies</span>
        <span><b>{preview.authUsers}</b> auth users</span>
        <span><b>{preview.buckets.length}</b> buckets</span>
        <span><b>{objects.toLocaleString()}</b> files ({formatBytes(bytes)})</span>
        <span><b>{preview.edgeFunctions.length}</b> edge functions</span>
        <span><b>{preview.secrets}</b> secrets <span style={{ color: 'var(--amber)' }}>(names only)</span></span>
      </div>
      {preview.secrets > 0 && (
        <div className="mb-2 text-[11px]" style={{ color: 'var(--text-mute)' }}>
          Supabase returns a hash of every secret value, never the value, so the names come across and the values
          are set here by hand.
        </div>
      )}
      {preview.tables.length > 0 && (
        <div className="max-h-32 overflow-y-auto">
          {preview.tables.map(t => (
            <div key={t.name} className="flex justify-between border-t hairline py-1" style={{ color: 'var(--text-mute)' }}>
              <span className="mono truncate">{t.name}</span>
              <span className="tabular-nums">{t.rows.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
      {preview.buckets.length > 0 && (
        <div className="max-h-24 overflow-y-auto">
          {/* Labelled: without it these rows read as more tables. */}
          <div className="mt-2 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-mute)' }}>Buckets</div>
          {preview.buckets.map(b => (
            <div key={b.name} className="flex justify-between border-t hairline py-1" style={{ color: 'var(--text-mute)' }}>
              <span className="mono truncate">{b.name}</span>
              <span className="tabular-nums">{b.objects.toLocaleString()} · {formatBytes(b.bytes)}</span>
            </div>
          ))}
        </div>
      )}
      {preview.edgeFunctions.length > 0 && (
        <>
          <div className="mt-2 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-mute)' }}>Edge functions</div>
          <div className="break-words font-mono text-[11px]" style={{ color: 'var(--text-mute)' }}>
            {preview.edgeFunctions.join(', ')}
          </div>
        </>
      )}
      {preview.notes.map((n, i) => (
        <div key={i} className="mt-1 flex items-start gap-1.5" style={{ color: 'var(--amber)' }}>
          <TriangleAlert size={12} className="mt-0.5 shrink-0" /><span>{n}</span>
        </div>
      ))}
    </div>
  );
}
