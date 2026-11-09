import { Database } from 'lucide-react';
import { useSchemas } from '@/shared/hooks/useSchemas';
import { SYSTEM_SCHEMAS, useSchema } from '@/shared/lib/schema';
import Select, { type SelectGroup } from '@/shared/ui/Select';


// Supabase-style schema switcher. Lists user schemas from the backend and binds
// the selection to the global schema preference. Custom Select with a "System"
// group for the platform-owned schemas.
export default function SchemaSelect({ className }: { className?: string }) {
  const { schema, setSchema } = useSchema();

  const schemasQ = useSchemas();
  const schemas = schemasQ.data ?? ['public'];
  const user = schemas.filter(s => !SYSTEM_SCHEMAS.has(s));
  const sys = schemas.filter(s => SYSTEM_SCHEMAS.has(s));

  const groups: SelectGroup[] = [
    { label: '', options: user.map(s => ({ value: s, label: s })) },
    ...(sys.length ? [{ label: 'System', options: sys.map(s => ({ value: s, label: s })) }] : []),
  ];

  return (
    <Select
      value={schema}
      onChange={setSchema}
      options={groups}
      label="schema"
      ariaLabel="Schema"
      leadingIcon={<Database size={12} />}
      className={className}
    />
  );
}
