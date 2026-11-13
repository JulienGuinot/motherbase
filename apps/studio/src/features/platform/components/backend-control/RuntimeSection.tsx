import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Hammer, Play, RotateCw, Square, type LucideIcon } from 'lucide-react';
import { platform, type ProjectRuntimeOptions } from '@/shared/lib/api';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { SettingRow } from '@/shared/ui/Row';
import { Section } from '@/shared/ui/Section';
import Select from '@/shared/ui/Select';
import { Toggle } from '@/shared/ui/Toggle';

interface RuntimeAction {
  label: string;
  icon: LucideIcon;
  run: (pid: string) => Promise<unknown>;
  title?: string;
}

const ACTIONS: RuntimeAction[] = [
  { label: 'start', icon: Play, run: platform.start },
  { label: 'stop', icon: Square, run: platform.stop },
  { label: 'restart', icon: RotateCw, run: platform.restart },
  { label: 'update', icon: Activity, run: platform.update },
  {
    label: 'rebuild',
    icon: Hammer,
    run: platform.rebuild,
    title: 'Rebuild image from source then restart (docker compose up --build -d)',
  },
];

const AUTO_PAUSE_CHOICES = [
  { value: '0', label: 'Never' },
  { value: '15', label: 'After 15 minutes' },
  { value: '60', label: 'After 1 hour' },
  { value: '360', label: 'After 6 hours' },
  { value: '1440', label: 'After 1 day' },
  { value: '10080', label: 'After 7 days' },
];

/** The fixed choices, plus the stored delay when the API or CLI set one that is not among them. */
function autoPauseOptions(current: number) {
  if (AUTO_PAUSE_CHOICES.some(choice => choice.value === String(current))) return AUTO_PAUSE_CHOICES;
  return [...AUTO_PAUSE_CHOICES, { value: String(current), label: `After ${current} minutes` }];
}

function capitalize(word: string): string {
  return word[0].toUpperCase() + word.slice(1);
}

export function RuntimeSection({ pid }: { pid: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const projectsQ = useQuery({
    queryKey: ['platform-projects'],
    queryFn: () => platform.list(),
    refetchInterval: 5000,
  });
  const status = projectsQ.data?.find(p => p.name === pid)?.status;

  const optionsKey = ['platform-runtime-options', pid];
  const { data: options } = useQuery({ queryKey: optionsKey, queryFn: () => platform.projectRuntimeOptions(pid) });
  // Not optimistic: the switch shows what the server stored, once it has.
  const saveOptions = useMutation({
    mutationFn: (patch: Partial<ProjectRuntimeOptions>) => platform.setProjectRuntimeOptions(pid, patch),
    onSuccess: saved => {
      qc.setQueryData(optionsKey, saved);
      toast.push({ kind: 'success', title: 'Runtime settings saved' });
    },
    onError: err => toast.push({ kind: 'error', title: getErrorMessage(err) ?? 'Could not save runtime settings' }),
  });

  const trigger = async ({ label, run }: RuntimeAction) => {
    setBusy(label);
    try {
      await run(pid);
      toast.push({ kind: 'success', title: `${label} requested` });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['platform-projects'] }),
        qc.invalidateQueries({ queryKey: ['platform-logs'] }),
      ]);
    } catch (err) {
      toast.push({ kind: 'error', title: getErrorMessage(err) ?? `${label} failed` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section bodyClassName="space-y-3" title="Runtime">
      <SettingRow label="Project">
        <span className="text-[12px]" style={{ fontWeight: 500 }}>{pid}</span>
      </SettingRow>
      <SettingRow label="Status" hint="Detected from Docker containers.">
        <span className="chip" style={{ color: status === 'running' ? 'var(--green)' : 'var(--text-mute)' }}>
          {status ? capitalize(status) : 'Unknown'}
        </span>
      </SettingRow>
      <SettingRow label="Actions" hint="Start, stop or restart the project API stack.">
        <div className="flex flex-wrap justify-end gap-2">
          {ACTIONS.map(action => (
            <button key={action.label} disabled={!!busy} onClick={() => trigger(action)} className="btn" title={action.title}>
              <action.icon size={12} /> {capitalize(action.label)}
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow
        label="Edge functions"
        hint="Runs the edge-runtime container. Off, the project uses less memory and its functions answer an error until it is turned back on. Their code and secrets are kept."
      >
        <Toggle
          checked={options?.edgeRuntime ?? true}
          onChange={edgeRuntime => saveOptions.mutate({ edgeRuntime })}
          disabled={!options || saveOptions.isPending}
          ariaLabel="Edge functions"
        />
      </SettingRow>
      <SettingRow
        label="Auto-pause"
        hint="Stops the project when it receives no request for this long. Its data is kept; it answers nothing, and runs no cron job, scheduled function or backup, until someone presses Start."
      >
        <Select
          value={String(options?.autoPauseMinutes ?? 0)}
          onChange={value => saveOptions.mutate({ autoPauseMinutes: Number(value) })}
          disabled={!options || saveOptions.isPending}
          ariaLabel="Auto-pause delay"
          align="right"
          options={autoPauseOptions(options?.autoPauseMinutes ?? 0)}
        />
      </SettingRow>
    </Section>
  );
}
