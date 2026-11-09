'use client';

import { Download, Search } from 'lucide-react';
import { Segmented } from '@/features/auth/components/Segmented';
import type { AccountFilter, RoleFilter, VerifFilter } from '@/features/auth/types';
import type { UserFilters } from '@/features/auth/hooks/useUserFilters';

/** Search box and the two facets above the users table. */
export function UsersToolbar({ filters, onExport }: { filters: UserFilters; onExport: () => void }) {
  return (
    <div className="card flex flex-wrap items-center gap-3 p-3">
      <div
        className="flex flex-1 min-w-[200px] items-center gap-2 border hairline-strong px-3 py-1.5"
        style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
      >
        <Search size={12} style={{ color: 'var(--text-mute)' }} />
        <input
          value={filters.query}
          onChange={e => filters.setQuery(e.target.value)}
          placeholder="Search"
          className="w-full bg-transparent text-[13px] outline-none placeholder:opacity-50"
        />
      </div>

      <Segmented
        label="Role"
        value={filters.role}
        onChange={v => filters.setRole(v as RoleFilter)}
        options={[{ v: 'all', l: 'All' }, { v: 'ADMIN', l: 'Admin' }, { v: 'USER', l: 'User' }]}
      />
      <Segmented
        label="Email"
        value={filters.verification}
        onChange={v => filters.setVerification(v as VerifFilter)}
        options={[{ v: 'all', l: 'All' }, { v: 'verified', l: 'Verified' }, { v: 'unverified', l: 'Unverified' }]}
      />
      <Segmented
        label="Account"
        value={filters.account}
        onChange={v => filters.setAccount(v as AccountFilter)}
        options={[{ v: 'all', l: 'All' }, { v: 'permanent', l: 'Permanent' }, { v: 'anonymous', l: 'Anonymous' }]}
      />

      <button onClick={onExport} className="btn">
        <Download size={12} /> Export
      </button>
    </div>
  );
}
