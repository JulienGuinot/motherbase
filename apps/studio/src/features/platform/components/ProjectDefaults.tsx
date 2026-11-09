import { useEffect, useState } from 'react';
import { platform, type DefaultableGroup } from '@/shared/lib/api';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { Note } from '@/shared/ui/Row';
import SettingsFields from '@/shared/ui/SettingsFields';
import { Checkbox } from '@/shared/ui/Field';

type Bundle = Record<string, Record<string, unknown>>;

// Operator editor for the settings every NEW project inherits at creation.
// Reuses the shared SettingsFields renderer; a group is only part of the bundle
// when its "Apply to new projects" switch is on.
export function ProjectDefaults() {
  const toast = useToast();
  const [groups, setGroups] = useState<DefaultableGroup[]>([]);
  const [bundle, setBundle] = useState<Bundle>({});
  const [jsonErr, setJsonErr] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const d = await platform.getProjectDefaults();
        setGroups(d.groups);
        setBundle(d.defaults);
      } catch (e) {
        toast.push({ kind: 'error', title: 'Failed to load defaults', message: getErrorMessage(e) });
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function fieldDefaults(g: DefaultableGroup): Record<string, unknown> {
    const v: Record<string, unknown> = {};
    for (const f of g.fields) if (f.default !== undefined) v[f.key] = f.default;
    return v;
  }

  function toggle(g: DefaultableGroup, on: boolean) {
    setBundle(prev => {
      const next = { ...prev };
      if (on) next[g.key] = { ...fieldDefaults(g), ...(prev[g.key] ?? {}) };
      else delete next[g.key];
      return next;
    });
  }

  function setField(groupKey: string, key: string, value: unknown) {
    setBundle(prev => ({ ...prev, [groupKey]: { ...(prev[groupKey] ?? {}), [key]: value } }));
  }

  async function save() {
    if (Object.values(jsonErr).some(Boolean)) {
      toast.push({ kind: 'error', title: 'Fix invalid JSON before saving' });
      return;
    }
    setSaving(true);
    try {
      const r = await platform.putProjectDefaults(bundle);
      setBundle(r.defaults);
      toast.push({ kind: 'success', title: 'Project defaults saved' });
    } catch (e) {
      toast.push({ kind: 'error', title: 'Save failed', message: getErrorMessage(e) });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>Loading…</p>;

  return (
    <div className="space-y-4">
      <Note>
        These values seed every NEW project at creation, so it inherits your baseline instead of the
        bare defaults. Existing projects are untouched. Secret groups (SMTP, S3, OAuth) are excluded
        and stay per-project.
      </Note>

      {groups.map(g => {
        const on = g.key in bundle;
        return (
          <div key={g.key} className="card p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[13px]" style={{ color: 'var(--text)', fontWeight: 600 }}>{g.label}</div>
                {g.description && (
                  <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-mute)' }}>{g.description}</div>
                )}
              </div>
              <Checkbox className="shrink-0" checked={on} onChange={v => toggle(g, v)} label="Apply to new projects" />
            </div>
            {on && (
              <div className="mt-4 border-t hairline pt-4">
                <SettingsFields
                  fields={g.fields}
                  values={bundle[g.key]}
                  setField={(k, v) => setField(g.key, k, v)}
                  jsonErr={jsonErr}
                  setJsonErr={setJsonErr}
                />
              </div>
            )}
          </div>
        );
      })}

      <div className="flex">
        <button className="btn btn-primary ml-auto" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save defaults'}
        </button>
      </div>
    </div>
  );
}
