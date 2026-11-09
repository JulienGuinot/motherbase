import { getErrorMessage } from '@/shared/lib/errors';
import { useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { sql as sqlLang } from '@codemirror/lang-sql';
import Select from '@/shared/ui/Select';
import { X } from 'lucide-react';
import { rlsApi, type PgPolicy } from '@/features/database/lib/rls-api';
import { useToast } from '@/shared/lib/toast';
import { useCodeMirrorTheme, overlayTooltips } from '@/shared/lib/codemirror-theme';
import { templates } from '@/features/database/lib/rls-templates';
import { Field } from '@/shared/ui/Field';
import {
  type PolicyDraft,
  type PolicyCommand,
  commandTakesCheck,
  buildCreatePolicySql,
  parsePolicySql,
} from '@/features/database/lib/rls-sql';

const COMMANDS: PolicyCommand[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL'];
const ROLES = ['anon', 'authenticated'];

function draftFromPolicy(p: PgPolicy): PolicyDraft {
  return {
    name: p.name,
    command: (p.command?.toUpperCase() as PolicyCommand) ?? 'ALL',
    role: p.roles[0] ?? 'authenticated',
    using: p.using ?? '',
    check: p.withCheck ?? '',
  };
}

function emptyDraft(table: string): PolicyDraft {
  return { name: `${table}_policy`, command: 'ALL', role: 'authenticated', using: '', check: '' };
}

function applyTemplateToDraft(base: PolicyDraft, templateId: string): PolicyDraft {
  const t = templates.find(x => x.id === templateId);
  if (!t) return base;
  const built = t.build({ ownerColumn: 'user_id' });
  return { ...base, command: built.command, role: built.role, using: built.using ?? '', check: built.check ?? '' };
}

export function PolicyEditor({
  table,
  initial,
  initialTemplate,
  onClose,
  onSaved,
}: {
  table: string;
  initial: PgPolicy | null;
  initialTemplate?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const cmTheme = useCodeMirrorTheme();
  const isEdit = initial !== null;
  const [draft, setDraft] = useState<PolicyDraft>(() => {
    if (initial) return draftFromPolicy(initial);
    const base = emptyDraft(table);
    return initialTemplate ? applyTemplateToDraft(base, initialTemplate) : base;
  });
  const [mode, setMode] = useState<'form' | 'sql'>('form');
  const [rawSql, setRawSql] = useState('');
  const [busy, setBusy] = useState(false);

  const generatedSql = useMemo(
    () => buildCreatePolicySql(table, draft, { drop: isEdit }),
    [table, draft, isEdit],
  );

  // Switching into SQL mode seeds the editor from the generated statement.
  function toSqlMode() {
    setRawSql(generatedSql);
    setMode('sql');
  }
  // Switching back parses the raw SQL; if unparseable, stay in SQL mode.
  function toFormMode() {
    const parsed = parsePolicySql(rawSql);
    if (!parsed) {
      toast.push({ kind: 'error', title: 'SQL too complex to edit as a form', message: 'Keep editing in SQL mode.' });
      return;
    }
    setDraft(parsed.draft);
    setMode('form');
  }

  function applyTemplate(id: string) {
    setDraft(d => applyTemplateToDraft(d, id));
  }

  async function save() {
    setBusy(true);
    try {
      if (mode === 'sql') {
        await rlsApi.runSql(rawSql);
      } else if (isEdit) {
        await rlsApi.replacePolicy(initial!.name, {
          table, name: draft.name, command: draft.command,
          role: draft.role as 'anon' | 'authenticated',
          using: draft.using || undefined,
          check: commandTakesCheck(draft.command) ? (draft.check || undefined) : undefined,
        });
      } else {
        await rlsApi.createPolicy({
          table, name: draft.name, command: draft.command,
          role: draft.role as 'anon' | 'authenticated',
          using: draft.using || undefined,
          check: commandTakesCheck(draft.command) ? (draft.check || undefined) : undefined,
        });
      }
      toast.push({ kind: 'success', title: isEdit ? 'Policy updated' : 'Policy created' });
      onSaved();
      onClose();
    } catch (err) {
      toast.push({ kind: 'error', title: 'Save failed', message: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex h-dvh w-full shrink-0 flex-col overflow-hidden border-l hairline md:static md:z-auto md:h-full md:w-[420px]" style={{ background: 'var(--ink-1)' }}>
      <header className="flex items-center justify-between border-b hairline px-4 py-3">
        <h3 className="text-[16px]" style={{ fontWeight: 500 }}>{isEdit ? 'Edit policy' : 'New policy'}</h3>
        <button className="btn btn-ghost" onClick={onClose}><X size={14} /></button>
      </header>

      {/* Mode toggle */}
      <div className="flex gap-1 border-b hairline px-4 py-2">
        <button
          className="btn btn-ghost text-[11px]"
          aria-pressed={mode === 'form'}
          style={{ color: mode === 'form' ? 'var(--paper)' : 'var(--paper-mute)', borderBottom: `2px solid ${mode === 'form' ? 'var(--accent)' : 'transparent'}` }}
          onClick={toFormMode}
        >Form</button>
        <button
          className="btn btn-ghost text-[11px]"
          aria-pressed={mode === 'sql'}
          style={{ color: mode === 'sql' ? 'var(--paper)' : 'var(--paper-mute)', borderBottom: `2px solid ${mode === 'sql' ? 'var(--accent)' : 'transparent'}` }}
          onClick={toSqlMode}
        >SQL</button>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {mode === 'form' ? (
          <div className="space-y-3">
            <div>
              <span className="label mb-1 block">Start from template</span>
              <div className="flex flex-wrap gap-2">
                {templates.map(t => (
                  <button key={t.id} className="chip" title={t.description} onClick={() => applyTemplate(t.id)}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <Field label="Policy name">
              <input className="input mono w-full" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
            </Field>

            <div className="flex gap-2">
              <label className="flex-1">
                <span className="label mb-1 block">Command</span>
                <Select
                  value={draft.command}
                  onChange={v => setDraft({ ...draft, command: v as PolicyCommand })}
                  ariaLabel="Command"
                  style={{ width: '100%' }}
                  options={COMMANDS.map(c => ({ value: c, label: c }))}
                />
              </label>
              <label className="flex-1">
                <span className="label mb-1 block">Role</span>
                <Select
                  value={draft.role}
                  onChange={v => setDraft({ ...draft, role: v })}
                  ariaLabel="Role"
                  style={{ width: '100%' }}
                  options={ROLES.map(r => ({ value: r, label: r }))}
                />
              </label>
            </div>

            <Field label="USING">
              <textarea className="input mono w-full" rows={2} value={draft.using} onChange={e => setDraft({ ...draft, using: e.target.value })} />
            </Field>

            {commandTakesCheck(draft.command) && (
              <Field label="WITH CHECK">
                <textarea className="input mono w-full" rows={2} value={draft.check} onChange={e => setDraft({ ...draft, check: e.target.value })} />
              </Field>
            )}

            <div>
              <span className="label mb-1 block">Generated SQL</span>
              <div className="border hairline" style={{ background: 'var(--code-bg)' }}>
                <CodeMirror value={generatedSql} editable={false} theme={cmTheme} extensions={[sqlLang(), overlayTooltips]} height="auto" basicSetup={{ lineNumbers: false }} />
              </div>
            </div>
          </div>
        ) : (
          <div className="border hairline" style={{ background: 'var(--code-bg)' }}>
            <CodeMirror value={rawSql} onChange={setRawSql} theme={cmTheme} extensions={[sqlLang(), overlayTooltips]} height="240px" basicSetup={{ lineNumbers: true }} />
          </div>
        )}
      </div>

      <footer className="flex justify-end gap-2 border-t hairline px-4 py-3">
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create policy'}
        </button>
      </footer>
    </div>
  );
}
