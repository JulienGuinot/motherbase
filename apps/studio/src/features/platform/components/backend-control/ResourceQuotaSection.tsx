import { useQuery, useQueryClient } from '@tanstack/react-query';
import { platform } from '@/shared/lib/api';
import { ResourceLimitsForm } from '@/shared/ui/ResourceLimitsForm';
import { Section } from '@/shared/ui/Section';

export function ResourceQuotaSection({ pid }: { pid: string }) {
  const qc = useQueryClient();
  const metricsQ = useQuery({
    queryKey: ['platform-metrics'],
    queryFn: platform.metrics,
    refetchInterval: 5000,
  });
  const usage = metricsQ.data?.projects.find(p => p.project === pid);

  const refreshAfterSave = () => {
    qc.invalidateQueries({ queryKey: ['platform-projects'] });
    qc.invalidateQueries({ queryKey: ['platform-metrics'] });
  };

  return (
    <Section bodyClassName="space-y-3" title="Resource quotas">
      <ResourceLimitsForm project={pid} usage={usage} onSaved={refreshAfterSave} />
    </Section>
  );
}
