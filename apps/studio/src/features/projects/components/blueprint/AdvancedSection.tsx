import { ChevronDown, HardDrive } from 'lucide-react';
import type { ProjectBlueprint } from '@/features/projects/hooks/useProjectBlueprint';
import { joinList, originError, splitList } from '@/shared/lib/list-values';
import { ListInput } from '@/shared/ui/ListInput';
import { FieldHint, FieldLabel, IconInput, SectionHeading } from './fields';

export function AdvancedSection({ blueprint, busy }: { blueprint: ProjectBlueprint; busy: boolean }) {
  const { storageDomain, corsOrigins } = blueprint;

  return (
    <details className="group border-t hairline-strong pt-6">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 [&::-webkit-details-marker]:hidden">
        <SectionHeading title="03 · Advanced" description="Optional overrides for storage routing and browser origins." />
        <ChevronDown size={16} className="shrink-0 transition-transform group-open:rotate-180" style={{ color: 'var(--text-mute)' }} />
      </summary>

      <div className="mt-5 grid gap-5">
        <label className="block">
          <FieldLabel label="Storage domain" aside={storageDomain ? 'custom' : 'default'} />
          <IconInput
            icon={HardDrive}
            value={storageDomain}
            onChange={event => blueprint.setStorageDomain(event.target.value)}
            placeholder={blueprint.effectiveStorage || 'storage.example.com'}
            disabled={busy}
          />
          <FieldHint>Leave blank to use the storage route shown in the manifest.</FieldHint>
        </label>

        <label htmlFor="blueprint-cors-origins" className="block">
          <FieldLabel label="Extra CORS origins" aside={corsOrigins ? 'custom' : 'optional'} />
          <ListInput
            id="blueprint-cors-origins"
            value={splitList(corsOrigins)}
            onChange={origins => blueprint.setCorsOrigins(joinList(origins))}
            placeholder="https://app.example.com"
            disabled={busy}
            mono
            validate={originError}
          />
          <FieldHint>Press Enter after each origin. The API domain is always allowed.</FieldHint>
        </label>
      </div>
    </details>
  );
}
