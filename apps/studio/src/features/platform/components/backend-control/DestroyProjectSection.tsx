import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { platform } from '@/shared/lib/api';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { SettingRow } from '@/shared/ui/Row';
import { Section } from '@/shared/ui/Section';

export function DestroyProjectSection({ pid }: { pid: string }) {
  const toast = useToast();
  const nav = useRouter();
  const destroy = useMutation({
    mutationFn: () => platform.destroy(pid),
    onSuccess: () => { toast.push({ kind: 'success', title: 'Project destroyed' }); nav.push('/'); },
    onError: (e) => toast.push({ kind: 'error', title: 'Destroy failed', message: getErrorMessage(e) }),
  });

  const confirmAndDestroy = async () => {
    const confirmed = await confirmDialog({
      title: `Destroy project "${pid}"?`,
      description: 'Its containers, volumes and database are permanently removed.',
      confirmLabel: 'Destroy project',
      tone: 'danger',
      typeToConfirm: pid,
    });
    if (confirmed) destroy.mutate();
  };

  return (
    <Section bodyClassName="space-y-3" title="Danger zone" tone="danger">
      <SettingRow label="Destroy project" hint="Stops and permanently removes this project's containers, volumes and database. Cannot be undone.">
        <button disabled={destroy.isPending} onClick={confirmAndDestroy} className="btn" style={{ color: 'var(--red)' }}>
          <Trash2 size={12} /> {destroy.isPending ? 'Destroying…' : 'Destroy project'}
        </button>
      </SettingRow>
    </Section>
  );
}
