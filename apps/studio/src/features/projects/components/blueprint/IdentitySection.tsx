import { Terminal } from 'lucide-react';
import type { ProjectBlueprint } from '@/features/projects/hooks/useProjectBlueprint';
import { FieldHint, FieldLabel, IconInput, REQUIRED_MARK, SectionHeading } from './fields';

function nameStatus({ name, nameError }: ProjectBlueprint): { label: string; color: string } {
  if (nameError) return { label: 'Fix name', color: 'var(--red)' };
  if (name) return { label: 'Resolved', color: 'var(--green)' };
  return { label: 'Required', color: 'var(--text-mute)' };
}

export function IdentitySection({ blueprint, busy }: { blueprint: ProjectBlueprint; busy: boolean }) {
  const { name, nameError } = blueprint;
  const status = nameStatus(blueprint);

  return (
    <section className="space-y-5">
      <SectionHeading
        title="01 · Identity"
        description="The slug becomes the Compose project name and default route prefix."
        aside={<span className="chip" style={{ color: status.color }}>{status.label}</span>}
      />

      <label className="block">
        <FieldLabel label={<>Project name {REQUIRED_MARK}</>} aside={name ? `${name.length} chars` : 'required'} />
        <IconInput
          icon={Terminal}
          iconColor={nameError ? 'var(--red)' : undefined}
          value={name}
          onChange={event => blueprint.setName(event.target.value)}
          placeholder="my-project"
          required
          autoFocus
          disabled={busy}
          aria-invalid={nameError || undefined}
        />
        <FieldHint color={nameError ? 'var(--red)' : undefined}>
          {nameError
            ? 'Use lowercase letters, numbers and dashes. Start with a letter or number.'
            : 'Invalid characters are removed as you type.'}
        </FieldHint>
      </label>
    </section>
  );
}
