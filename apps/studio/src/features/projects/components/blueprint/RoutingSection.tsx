import { Globe } from 'lucide-react';
import type { ProjectBlueprint } from '@/features/projects/hooks/useProjectBlueprint';
import { FieldHint, FieldLabel, IconInput, REQUIRED_MARK, SectionHeading } from './fields';

function routingHint({ suffix, dev }: ProjectBlueprint): string {
  if (!suffix) return 'Use a domain already routed to this server. External custom domains need their own DNS record.';
  return dev
    ? 'Dev mode uses http routes on localhost with no DNS or TLS step.'
    : 'Generated from the platform wildcard DNS. No DNS change is needed for this project.';
}

export function RoutingSection({ blueprint, busy }: { blueprint: ProjectBlueprint; busy: boolean }) {
  const { dev, name, domain, domainTouched, autoDomain, routeMode } = blueprint;

  return (
    <section className="space-y-5 border-t hairline-strong pt-6">
      <SectionHeading
        title="02 · Routing"
        description="Keep the generated route from the setup wildcard or override it with a custom domain."
        aside={
          <span className="chip" style={{ color: routeMode === 'Pending' ? 'var(--text-mute)' : 'var(--text-dim)' }}>
            {routeMode}
          </span>
        }
      />

      <label className="block">
        <FieldLabel label={<>API domain {!dev && REQUIRED_MARK}</>} aside={blueprint.suffixLabel} />
        <IconInput
          icon={Globe}
          value={domainTouched ? domain : domain || autoDomain}
          onChange={event => blueprint.setDomain(event.target.value)}
          placeholder={dev ? `${name || '<name>'}.localhost (auto)` : 'api.example.com'}
          disabled={busy}
        />
        <FieldHint>{routingHint(blueprint)}</FieldHint>
      </label>
    </section>
  );
}
