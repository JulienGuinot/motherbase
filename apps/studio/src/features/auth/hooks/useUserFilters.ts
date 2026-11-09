'use client';

import { useState } from 'react';
import { useDebounced } from '@/shared/hooks/useDebounced';
import { usePersistentState } from '@/shared/hooks/usePersistentState';
import type { UserListFilter } from '@/features/auth/api/users.api';
import type { AccountFilter, RoleFilter, VerifFilter } from '@/features/auth/types';

export interface UserFilters {
  query: string;
  setQuery: (value: string) => void;
  role: RoleFilter;
  setRole: (value: RoleFilter) => void;
  verification: VerifFilter;
  setVerification: (value: VerifFilter) => void;
  account: AccountFilter;
  setAccount: (value: AccountFilter) => void;
}

export const USER_PAGE_SIZES = [25, 50, 100, 250];

/** The toolbar's choices as the server's query: `all` is the absence of a filter. */
export function toUserListFilter({
  query,
  role,
  verification,
  account,
}: Pick<UserFilters, 'query' | 'role' | 'verification' | 'account'>): UserListFilter {
  return {
    q: query.trim() || undefined,
    role: role === 'all' ? undefined : role,
    verified: verification === 'all' ? undefined : verification === 'verified',
    anonymous: account === 'all' ? undefined : account === 'anonymous',
  };
}

/**
 * Search, facet and page state for the users table. The filtering itself is
 * the server's: it used to run here, over every user of the project fetched
 * in one request.
 */
export function useUserFilters() {
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<RoleFilter>('all');
  const [verification, setVerification] = useState<VerifFilter>('all');
  const [account, setAccount] = useState<AccountFilter>('all');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = usePersistentState('console.usersPerPage', 50);
  // The text box stays instant; only the request behind it waits.
  const debouncedQuery = useDebounced(query, 300);

  // A narrower filter can leave page 7 empty, so every change starts over at 1.
  const resettingPage = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setPage(1);
  };

  return {
    filters: {
      query,
      setQuery: resettingPage(setQuery),
      role,
      setRole: resettingPage(setRole),
      verification,
      setVerification: resettingPage(setVerification),
      account,
      setAccount: resettingPage(setAccount),
    } satisfies UserFilters,
    filter: toUserListFilter({ query: debouncedQuery, role, verification, account }),
    page,
    setPage,
    perPage,
    setPerPage: resettingPage(setPerPage),
  };
}
