'use client';

import { SkeletonList } from '@/shared/ui/Skeleton';
import { SidebarHeader } from '@/shared/ui/SidebarHeader';
import { STATIC_GROUPS } from '@/features/api-tools/lib/endpoints';

/**
 * Model groups, in their two real families.
 *
 * There is deliberately no schema picker: the REST catalogue is pinned to
 * `public`, the only schema `rest-model.ts` serves. But the list also carries
 * the fixed `/admin` route groups (Auth, Storage, SQL…), which are not tables of
 * any schema, so labelling the whole sidebar "schema public" was simply false,
 * as `Auth` sitting under it made obvious. Each family now says what it is.
 */
export function EndpointGroupList({
  groups,
  selected,
  total,
  isLoading,
  onSelect,
}: {
  groups: string[];
  selected: string | null;
  total: number;
  isLoading: boolean;
  onSelect: (group: string) => void;
}) {
  const admin = groups.filter(group => STATIC_GROUPS.has(group));
  const rest = groups.filter(group => !STATIC_GROUPS.has(group));

  const item = (group: string) => (
    <li key={group}>
      <button
        onClick={() => onSelect(group)}
        className="flex w-full items-center px-4 py-2 text-left text-[12px]"
        style={{
          background: selected === group ? 'var(--hover)' : 'transparent',
          color: selected === group ? 'var(--text)' : 'var(--text-dim)',
          borderLeft: `2px solid ${selected === group ? 'var(--accent)' : 'transparent'}`,
        }}
      >
        {group}
      </button>
    </li>
  );

  const heading = (text: string, hint: string) => (
    <li className="px-4 pb-1 pt-3 first:pt-1">
      <p className="label" style={{ fontSize: 10 }}>
        {text}
      </p>
      <p className="mt-0.5 text-[10px]" style={{ color: 'var(--text-mute)' }}>
        {hint}
      </p>
    </li>
  );

  return (
    <aside
      className="flex h-[210px] w-full shrink-0 flex-col overflow-hidden border-b hairline md:h-auto md:w-44 md:border-b-0 md:border-r"
      style={{ background: 'var(--surface-2)' }}
    >
      <SidebarHeader title="Models" />

      <ul className="flex-1 overflow-auto py-1">
        {isLoading && (
          <li className="px-3 py-2">
            <SkeletonList rows={6} height={24} />
          </li>
        )}

        {rest.length > 0 && heading('REST', 'tables in schema public')}
        {rest.map(item)}

        {admin.length > 0 && heading('Admin API', 'console routes under /admin')}
        {admin.map(item)}
      </ul>

      <div className="border-t hairline px-4 py-2 text-[10px]" style={{ color: 'var(--text-mute)' }}>
        {total} routes total
      </div>
    </aside>
  );
}
