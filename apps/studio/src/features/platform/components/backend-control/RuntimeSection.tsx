import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Hammer, Play, RotateCw, Square, type LucideIcon } from 'lucide-react';
import { platform } from '@/shared/lib/api';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { SettingRow } from '@/shared/ui/Row';
import { Section } from '@/shared/ui/Section';

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
    </Section>
  );
}
