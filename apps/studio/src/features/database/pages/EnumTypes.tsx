'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import SchemaSelect from '@/shared/ui/SchemaSelect';
import { QueryState } from '@/shared/ui/QueryState';
import { EmptyState } from '@/shared/ui/EmptyState';
import { Section } from '@/shared/ui/Section';
import { WriteButton } from '@/shared/ui/WriteButton';
import { ListInput } from '@/shared/ui/ListInput';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { useSchema } from '@/shared/lib/schema';
import { useToast } from '@/shared/lib/toast';
import { catalogApi, type EnumChange, type EnumType } from '@/features/database/api/catalog.api';
import { NewEnumModal } from '@/features/database/components/NewEnumModal';
import { useCatalogWrite, useEnumTypes } from '@/features/database/hooks/useCatalog';
import { useProjectCapability } from '@/features/platform/hooks/usePlatformAccess';
import { enumChanges } from '@/features/database/lib/enum-changes';

/**
 * Database > Enumerated Types.
 *
 * Postgres can add and rename enum values but never remove one (a row may
 * hold it), so the values are edited in place as chips that rename and append
 * but carry no remove button: the page offers exactly what the database can do.
 */
export default function EnumTypes() {
  const { schema } = useSchema();
  const enumsQuery = useEnumTypes(schema);
  const [creating, setCreating] = useState(false);
  const toast = useToast();

  const create = useCatalogWrite({
    run: ({ name, values }: { name: string; values: string[] }) => catalogApi.createEnum(schema, name, values),
    invalidate: 'schema.changed',
    success: ({ name }) => `Created ${name}`,
    failTitle: 'Create failed',
    onSuccess: () => setCreating(false),
  });
  const drop = useCatalogWrite({
    run: (type: EnumType) => catalogApi.dropEnum(schema, type.name),
    invalidate: 'schema.changed',
    success: type => `Dropped ${type.name}`,
    failTitle: 'Drop failed',
  });

  const confirmDrop = async (type: EnumType) => {
    // Postgres would refuse too; saying which columns saves the round trip.
    if (type.usedBy.length) {
      toast.push({ kind: 'error', title: `${type.name} is still in use`, message: `Change or drop these columns first: ${type.usedBy.join(', ')}.` });
      return;
    }
    if (await confirmDialog({ title: `Drop type "${type.name}"?`, confirmLabel: 'Drop type', tone: 'danger' })) drop.mutate(type);
  };

  return (
    <PageShell width="wide">
      <PageHeader
        title="Enumerated Types"
        subtitle="Custom types whose value is one of a fixed list, such as an order status."
        actions={
          <>
            <SchemaSelect />
            <WriteButton className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={12} /> New type
            </WriteButton>
          </>
        }
      />

      <QueryState
        query={enumsQuery}
        empty={
          <div className="card">
            <EmptyState size="md" mascot="plug-cable" title={`No enumerated types in ${schema}`} description="Create one, then pick it as a column type in the Table Editor." />
          </div>
        }
      >
        {types => (
          <div className="grid gap-3">
            {types.map(type => (
              <Section
                key={type.name}
                title={<span className="mono">{type.name}</span>}
                description={type.usedBy.length ? `Used by ${type.usedBy.join(', ')}` : 'Not used by any column yet.'}
                actions={
                  <WriteButton className="btn btn-ghost" style={{ color: 'var(--danger)' }} title="Drop type" onClick={() => confirmDrop(type)}>
                    <Trash2 size={12} />
                  </WriteButton>
                }
              >
                <EnumValues schema={schema} type={type} />
              </Section>
            ))}
          </div>
        )}
      </QueryState>

      {creating && (
        <NewEnumModal saving={create.isPending} onSave={(name, values) => create.mutate({ name, values })} onClose={() => setCreating(false)} />
      )}
    </PageShell>
  );
}

/**
 * One type's values, edited in place. Each edit becomes the ALTER TYPE steps
 * that produce it, sent in order; the list shows the edit until the refetched
 * type replaces it, and falls back to the server's values if a step fails.
 */
function EnumValues({ schema, type }: { schema: string; type: EnumType }) {
  const toast = useToast();
  const { editable, pending: accessPending } = useProjectCapability('content.write');
  // The edit in flight, with the values it was made against: once the refetch
  // hands over a new list, the edit is the server's to show.
  const [pending, setPending] = useState<{ from: readonly string[]; next: string[] } | null>(null);
  const shown = pending?.from === type.values ? pending.next : type.values;

  const alter = useCatalogWrite({
    run: async (changes: EnumChange[]) => {
      for (const change of changes) await catalogApi.alterEnum(schema, type.name, change);
    },
    invalidate: 'schema.changed',
    success: `Updated ${type.name}`,
    failTitle: 'Update failed',
  });

  const edit = (next: string[]) => {
    const changes = enumChanges(type.values, next);
    if (!changes) {
      toast.push({ kind: 'error', title: 'Values cannot be removed', message: `Postgres cannot drop or merge a value of ${type.name}: a row may hold it.` });
      return;
    }
    if (!changes.length) return;
    setPending({ from: type.values, next });
    alter.mutate(changes, { onError: () => setPending(null) });
  };

  return (
    <>
      <ListInput
        id={`enum-${type.name}`}
        mono
        removable={false}
        disabled={(!accessPending && !editable) || alter.isPending}
        value={shown}
        onChange={edit}
        placeholder="Add a value"
      />
      <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-mute)' }}>
        Type to append a value, click one to rename it. Rows holding a renamed value keep it under the new name.
      </p>
    </>
  );
}
