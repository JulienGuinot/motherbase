import { Plus, Trash2 } from 'lucide-react';
import Select from '@/shared/ui/Select';
import { Toggle } from '@/shared/ui/Toggle';
import {
  THIRD_PARTY_TYPES,
  newProvider,
  providerProblems,
  type ThirdPartyProvider,
} from '../lib/third-party';

/** One card per trusted issuer; the list is the group's `providers` value. */
export function ThirdPartyProvidersField({
  providers,
  onChange,
  editable,
}: {
  providers: ThirdPartyProvider[];
  onChange: (providers: ThirdPartyProvider[]) => void;
  editable: boolean;
}) {
  const problems = providerProblems(providers);
  const patch = (index: number, change: Partial<ThirdPartyProvider>) =>
    onChange(providers.map((p, i) => (i === index ? { ...p, ...change } : p)));

  return (
    <div className="space-y-3">
      {providers.length === 0 && (
        <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
          No third-party providers. Only Motherbase sessions and API keys are accepted.
        </p>
      )}
      {providers.map((p, i) => {
        const hint = THIRD_PARTY_TYPES.find(t => t.value === p.type)?.issuerHint;
        const problem = problems.get(i);
        return (
          <div key={i} className="card space-y-2 p-3">
            <div className="flex items-center gap-2">
              <Select
                value={p.type}
                onChange={type => patch(i, { type: type as ThirdPartyProvider['type'] })}
                options={THIRD_PARTY_TYPES.map(t => ({ value: t.value, label: t.label }))}
                disabled={!editable}
                ariaLabel="Provider type"
              />
              <input
                className="input mono min-w-0 flex-1"
                aria-label="Provider id"
                value={p.id}
                disabled={!editable}
                onChange={e => patch(i, { id: e.target.value })}
              />
              <Toggle checked={p.enabled} onChange={enabled => patch(i, { enabled })} disabled={!editable} ariaLabel="Enabled" />
              <button
                type="button"
                className="btn"
                aria-label="Remove provider"
                disabled={!editable}
                onClick={() => onChange(providers.filter((_, j) => j !== i))}
              >
                <Trash2 size={13} />
              </button>
            </div>
            <input
              className="input mono w-full"
              aria-label="Issuer"
              placeholder={hint}
              value={p.issuer}
              disabled={!editable}
              onChange={e => patch(i, { issuer: e.target.value })}
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                className="input mono"
                aria-label="JWKS URL"
                placeholder="JWKS URL (optional)"
                value={p.jwksUrl}
                disabled={!editable}
                onChange={e => patch(i, { jwksUrl: e.target.value })}
              />
              <input
                className="input mono"
                aria-label="Audience"
                placeholder="Audience (optional)"
                value={p.audience}
                disabled={!editable}
                onChange={e => patch(i, { audience: e.target.value })}
              />
            </div>
            {problem && <p className="text-[11px]" style={{ color: 'var(--red)' }}>{problem}</p>}
          </div>
        );
      })}
      <button
        type="button"
        className="btn"
        disabled={!editable}
        onClick={() => onChange([...providers, newProvider(providers)])}
      >
        <Plus size={13} /> Add provider
      </button>
    </div>
  );
}
