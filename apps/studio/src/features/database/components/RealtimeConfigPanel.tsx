import { useMutation, useQueryClient } from '@tanstack/react-query';
import { optimistic } from '@/shared/lib/optimistic';
import type { RealtimeConfig } from '@/features/database/types';
import { realtimeApi } from '@/features/database/api/realtime.api';
import { useRealtimeConfig } from '@/features/database/hooks/useRealtime';
import { useToast } from '@/shared/lib/toast';
import { Badge, type Tone } from '@/shared/ui/Badge';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';

const RISK_META: Record<string, { label: string; tone: Tone }> = {
  public: { label: 'public', tone: 'success' },
  restricted: { label: 'auth', tone: 'warn' },
  private: { label: 'private', tone: 'danger' },
  none: { label: 'no access', tone: 'neutral' },
};

function riskBadge(riskLevel: string) {
  return RISK_META[riskLevel] ?? RISK_META.none;
}

export function RealtimeConfigPanel() {
  const toast = useToast();
  const qc = useQueryClient();

  const configQ = useRealtimeConfig();

  // Both of these are checkboxes in a table of thirty models. They paint the
  // new state on click and roll back if the PATCH fails. No success toast: the
  // checkbox itself is the confirmation.
  const update = useMutation({
    mutationFn: (models: string[]) => realtimeApi.setModels(models),
    ...optimistic<RealtimeConfig, string[]>(qc, toast, ['rt-config'],
      (config, models) => ({ ...config, models, configured: true }),
      'Save failed'),
  });

  const respectRls = useMutation({
    mutationFn: ({ model, respectRls }: { model: string; respectRls: boolean }) =>
      realtimeApi.setRespectRls(model, respectRls),
    ...optimistic<RealtimeConfig, { model: string; respectRls: boolean }>(qc, toast, ['rt-config'],
      (config, vars) => ({
        ...config,
        availableModels: config.availableModels.map(entry =>
          entry.model === vars.model ? { ...entry, respectRls: vars.respectRls } : entry),
      }),
      'Save failed'),
  });

  function toggle(model: string) {
    const current = configQ.data?.models ?? [];
    const next = current.includes(model) ? current.filter(item => item !== model) : [...current, model];
    update.mutate(next);
  }

  const availableModels = configQ.data?.availableModels ?? [];
  const enabledModels = configQ.data?.models ?? [];

  return (
    <div className="card p-5">
      <div className="mb-1 flex items-center gap-2">
        <div className="text-[13px]" style={{ fontWeight: 600 }}>Broadcasting per model</div>
        <span className="chip ml-auto tabular-nums">{enabledModels.length}/{availableModels.length} enabled</span>
        {configQ.data && !configQ.data.configured && <span className="chip">default: all enabled</span>}
      </div>
      <p className="mb-4 text-[12px]" style={{ color: 'var(--text-mute)' }}>
        Turn a model on to push create/update/delete events to WebSocket subscribers. "RLS filter" decides who
        receives them: on means each subscriber only gets rows their own REST policies let them read; off means
        every subscriber sees every row regardless of policies. Only safe for genuinely public data.
      </p>
      {/* overflow-x-auto, not hidden: this table needs 330px and a phone has
          320, so `hidden` cut the RLS filter column off with no way to reach
          it. Rounded corners still need the clip, hence both axes named. */}
      <div className="overflow-x-auto overflow-y-hidden border hairline" style={{ borderRadius: 'var(--radius-sm)' }}>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b hairline text-left" style={{ color: 'var(--text-mute)' }}>
              <th className="px-3 py-2 font-normal">Model</th>
              <th className="px-3 py-2 font-normal">Access</th>
              <th className="px-3 py-2 font-normal">Broadcasting</th>
              <th className="px-3 py-2 font-normal">RLS filter</th>
            </tr>
          </thead>
          <tbody>
            {availableModels.map(table => {
              const enabled = enabledModels.includes(table.model);
              const badge = riskBadge(table.riskLevel);
              return (
                <tr key={table.model} className="border-b hairline last:border-b-0">
                  <td className="px-3 py-2">
                    <span className="mono truncate">{table.model}</span>
                    {table.dynamic && <span className="chip ml-1.5 text-[10px]">SQL</span>}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={badge.tone} className="text-[10px]">{badge.label}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={async () => {
                          if (update.isPending) return;
                          if (!enabled && !table.respectRls && (table.riskLevel === 'private' || table.riskLevel === 'none')) {
                            const confirmed = await confirmDialog({
                              title: `Broadcast "${table.model}" unfiltered?`,
                              description:
                                'This model does not filter by RLS, so every subscriber receives every row of it, bypassing your REST policies. Turn on the RLS filter instead unless unfiltered broadcasting is what you want.',
                              confirmLabel: 'Broadcast unfiltered',
                              tone: 'danger',
                            });
                            if (!confirmed) return;
                          }
                          toggle(table.model);
                        }}
                        disabled={update.isPending}
                      />
                      <span style={{ color: 'var(--text-dim)' }}>{enabled ? 'On' : 'Off'}</span>
                    </label>
                  </td>
                  <td className="px-3 py-2">
                    <label
                      className="flex cursor-pointer items-center gap-2"
                      title="Only push rows each subscriber is allowed to read via REST policies"
                    >
                      <input
                        type="checkbox"
                        checked={table.respectRls}
                        onChange={() => {
                          if (respectRls.isPending) return;
                          respectRls.mutate({ model: table.model, respectRls: !table.respectRls });
                        }}
                        disabled={respectRls.isPending}
                      />
                      <span style={{ color: table.respectRls ? 'var(--text-dim)' : 'var(--amber)' }}>
                        {table.respectRls ? 'On' : 'Off. Unfiltered'}
                      </span>
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
