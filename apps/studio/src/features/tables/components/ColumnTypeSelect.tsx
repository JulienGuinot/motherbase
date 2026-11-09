import { useState } from 'react';
import { Plus } from 'lucide-react';
import { catalogApi } from '@/features/database/api/catalog.api';
import { NewEnumModal } from '@/features/database/components/NewEnumModal';
import { useCatalogWrite } from '@/features/database/hooks/useCatalog';
import { useColumnTypeGroups } from '@/features/tables/hooks/useColumnTypes';
import { enumTypeRef } from '@/features/tables/lib/column-types';
import Select, { type SelectProps } from '@/shared/ui/Select';
import { WriteButton } from '@/shared/ui/WriteButton';

type Props = Omit<SelectProps, 'options' | 'footer' | 'value' | 'onChange'> & {
  schema: string;
  value: string;
  onChange: (type: string) => void;
};

/**
 * Column type picker with a footer to mint an enumerated type in this schema
 * and select it, so the operator does not have to leave the table editor.
 */
export function ColumnTypeSelect({ schema, value, onChange, ...selectProps }: Props) {
  const typeGroups = useColumnTypeGroups(schema);
  const [creating, setCreating] = useState(false);
  const create = useCatalogWrite({
    run: ({ name, values }: { name: string; values: string[] }) => catalogApi.createEnum(schema, name, values),
    invalidate: 'schema.changed',
    success: ({ name }) => `Created ${name}`,
    failTitle: 'Create failed',
    onSuccess: (_result, { name }) => {
      setCreating(false);
      onChange(enumTypeRef(schema, name));
    },
  });

  return (
    <>
      <Select
        value={value}
        onChange={onChange}
        options={typeGroups}
        footer={close => (
          <WriteButton
            type="button"
            onClick={() => { close(); setCreating(true); }}
            className="nav-item flex w-full items-center gap-2 px-2 py-1.5 text-[13px]"
            style={{ borderRadius: 'var(--radius-sm)', color: 'var(--accent)' }}
          >
            <Plus size={14} /> New enumerated type
          </WriteButton>
        )}
        {...selectProps}
      />
      {creating && (
        <NewEnumModal
          saving={create.isPending}
          onSave={(name, values) => create.mutate({ name, values })}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
}
