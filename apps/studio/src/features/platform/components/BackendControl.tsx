import { project } from '@/shared/lib/project';
import { Section } from '@/shared/ui/Section';
import { ConsoleLogSection } from '@/features/platform/components/backend-control/ConsoleLogSection';
import { ContainerLogSection } from '@/features/platform/components/backend-control/ContainerLogSection';
import { DestroyProjectSection } from '@/features/platform/components/backend-control/DestroyProjectSection';
import { DnsChecksSection } from '@/features/platform/components/backend-control/DnsChecksSection';
import { ProjectShellSection } from '@/features/platform/components/backend-control/ProjectShellSection';
import { ResourceQuotaSection } from '@/features/platform/components/backend-control/ResourceQuotaSection';
import { RuntimeSection } from '@/features/platform/components/backend-control/RuntimeSection';

export function BackendControl() {
  const pid = project.get();

  if (!pid) {
    return (
      <Section bodyClassName="space-y-3" title="Backend control">
        <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>Open a project to control its backend.</p>
      </Section>
    );
  }

  return (
    <div className="space-y-6">
      <RuntimeSection pid={pid} />
      <ProjectShellSection pid={pid} />
      <DnsChecksSection pid={pid} />
      <ConsoleLogSection />
      <ContainerLogSection pid={pid} />
      <ResourceQuotaSection pid={pid} />
      <DestroyProjectSection pid={pid} />
    </div>
  );
}
