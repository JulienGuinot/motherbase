import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { usersApi, type UserListFilter } from '@/features/auth/api/users.api';

export function useUsers(params: { page: number; perPage: number; filter: UserListFilter }) {
  return useQuery({
    queryKey: ['users', params],
    queryFn: () => usersApi.list(params),
    // Safe here, as on the Sessions page: the rows are self-describing, so the
    // previous page shown while the next one loads is still correct.
    placeholderData: keepPreviousData,
  });
}

export function useUserDetail(id: string) {
  return useQuery({
    queryKey: ['user-detail', id],
    queryFn: () => usersApi.detail(id),
  });
}
