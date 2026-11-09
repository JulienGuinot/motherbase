import { Database, HardDrive, ShieldCheck, Terminal, type LucideIcon } from 'lucide-react';
import type { SupabaseImportOption } from '@/features/projects/hooks/useSupabaseImportOption';
import SupabaseLogo from '@/shared/ui/SupabaseLogo';
import {
  SUPABASE_CONN_HINT,
  SUPABASE_CONN_PLACEHOLDER,
  SUPABASE_MANAGEMENT_TOKEN_HINT,
  SUPABASE_SERVICE_KEY_HINT,
  SUPABASE_TOKENS_URL,
  supabaseApiKeysUrl,
  supabaseConnectUrl,
} from '../../supabase-conn';
import SupabaseDashboardLink from '../SupabaseDashboardLink';
import { FieldHint, FieldLabel, IconInput, REQUIRED_MARK, SectionHeading } from './fields';

type ImportKey = keyof SupabaseImportOption['include'];

const IMPORT_CHOICES: ReadonlyArray<[ImportKey, string]> = [
  ['schema', 'Schema & RLS policies'],
  ['data', 'Table data'],
  ['auth', 'Auth users'],
  ['storage', 'Buckets & files'],
  ['edgeFunctions', 'Edge functions'],
  ['secrets', 'Secrets'],
];

const secretInputProps = { type: 'password', spellCheck: false, autoComplete: 'off', mono: true } as const;

function Checkbox({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled: boolean }) {
  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[12px]" style={{ color: 'var(--text-dim)' }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
        disabled={disabled}
        className="h-4 w-4 accent-[var(--accent)]"
      />
      {label}
    </label>
  );
}

function ConnectionField({ supabase, busy }: { supabase: SupabaseImportOption; busy: boolean }) {
  const { connectionString, connectionUsable } = supabase;
  const state = connectionString ? (connectionUsable ? 'looks valid' : 'unusable URI') : 'required';

  return (
    <label className="block">
      <FieldLabel
        label={<>Supabase session pooler URI {REQUIRED_MARK}</>}
        aside={state}
        asideColor={connectionUsable ? 'var(--green)' : undefined}
      />
      <IconInput
        icon={Database}
        iconColor={connectionUsable ? 'var(--accent)' : undefined}
        value={connectionString}
        onChange={event => supabase.setConnectionString(event.target.value)}
        placeholder={SUPABASE_CONN_PLACEHOLDER}
        disabled={busy}
        spellCheck={false}
        autoComplete="off"
        mono
      />
      <FieldHint>{SUPABASE_CONN_HINT}</FieldHint>
      <SupabaseDashboardLink href={supabaseConnectUrl(connectionString)} label="Open Supabase → Connect" />
      {supabase.issues.map((issue, index) => (
        <p key={index} className="mt-1 text-[11px] leading-5" style={{ color: issue.level === 'error' ? 'var(--red)' : 'var(--amber)' }}>
          {issue.message}
        </p>
      ))}
    </label>
  );
}

function OptionalSecretField({
  label,
  icon,
  value,
  onChange,
  placeholder,
  hint,
  link,
  busy,
}: {
  label: string;
  icon: LucideIcon;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  hint: string;
  link: { href: string; label: string };
  busy: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[12px]" style={{ color: 'var(--text-dim)', fontWeight: 500 }}>
        {label} <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>· optional</span>
      </span>
      <div className="mt-2">
        <IconInput
          icon={icon}
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder={placeholder}
          disabled={busy}
          {...secretInputProps}
        />
      </div>
      <FieldHint>{hint}</FieldHint>
      <SupabaseDashboardLink href={link.href} label={link.label} />
    </label>
  );
}

function ImportSelectionPicker({ supabase, busy }: { supabase: SupabaseImportOption; busy: boolean }) {
  return (
    <div>
      <span className="text-[12px]" style={{ color: 'var(--text-dim)', fontWeight: 500 }}>What to import</span>
      <div className="mt-2 flex flex-wrap gap-4">
        {IMPORT_CHOICES.map(([key, label]) => (
          <Checkbox key={key} label={label} checked={supabase.include[key]} onChange={on => supabase.setIncludeKey(key, on)} disabled={busy} />
        ))}
      </div>
      {supabase.noneSelected && <p className="mt-2 text-[11px]" style={{ color: 'var(--red)' }}>Pick at least one thing to import.</p>}
    </div>
  );
}

export function SupabaseImportSection({ supabase, busy }: { supabase: SupabaseImportOption; busy: boolean }) {
  return (
    <section className="space-y-5 border-t hairline-strong pt-6">
      <SectionHeading
        title={<><SupabaseLogo size={15} /> 04 · Import from Supabase</>}
        description="Optional. Copy an existing Supabase project over in one go: schema, data, RLS policies, auth users, buckets and their files, edge functions and secrets."
        aside={<Checkbox label="Enable" checked={supabase.enabled} onChange={supabase.setEnabled} disabled={busy} />}
      />

      {supabase.enabled && (
        <div className="grid gap-5">
          <ConnectionField supabase={supabase} busy={busy} />
          <OptionalSecretField
            label="service_role key"
            icon={HardDrive}
            value={supabase.serviceRoleKey}
            onChange={supabase.setServiceRoleKey}
            placeholder="eyJhbGciOi…"
            hint={SUPABASE_SERVICE_KEY_HINT}
            link={{ href: supabaseApiKeysUrl(supabase.connectionString), label: 'Open Supabase → API keys' }}
            busy={busy}
          />
          <OptionalSecretField
            label="Personal access token"
            icon={Terminal}
            value={supabase.managementToken}
            onChange={supabase.setManagementToken}
            placeholder="sbp_…"
            hint={SUPABASE_MANAGEMENT_TOKEN_HINT}
            link={{ href: SUPABASE_TOKENS_URL, label: 'Open Supabase → Generate new token' }}
            busy={busy}
          />
          <ImportSelectionPicker supabase={supabase} busy={busy} />
          <div
            className="flex items-start gap-2 border px-3 py-2.5 text-[11px] leading-5"
            style={{ borderColor: 'var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-mute)' }}
          >
            <ShieldCheck size={13} style={{ color: 'var(--text-mute)', marginTop: 1, flexShrink: 0 }} />
            The project is created first, then the import runs against it. Sections without their credential report what they could not read rather than failing. This can take a while for large databases and large buckets.
          </div>
        </div>
      )}
    </section>
  );
}
