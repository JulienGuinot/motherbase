import type { SelectGroup } from '@/shared/ui/Select';

/** Built-in types every column picker offers, most common first. */
export const BASE_COLUMN_TYPES = ['uuid', 'text', 'varchar(255)', 'integer', 'bigint', 'boolean', 'timestamptz', 'date', 'jsonb', 'float8', 'numeric'];

/**
 * How a column definition names an enum. Unqualified in `public`, which is
 * on the search path; schema-qualified anywhere else, or `ALTER TABLE ...
 * ADD COLUMN mood mood` resolves against `public` and fails.
 */
export function enumTypeRef(schema: string, name: string): string {
  return schema === 'public' ? name : `${schema}.${name}`;
}

/** Built-in types, then the schema's enumerated types as their own group. */
export function columnTypeGroups(schema: string, enumNames: string[]): SelectGroup[] {
  const groups: SelectGroup[] = [{ label: '', options: BASE_COLUMN_TYPES.map(type => ({ value: type, label: type })) }];
  if (enumNames.length) {
    groups.push({
      label: 'Enumerated types',
      options: enumNames.map(name => ({ value: enumTypeRef(schema, name), label: enumTypeRef(schema, name) })),
    });
  }
  return groups;
}
