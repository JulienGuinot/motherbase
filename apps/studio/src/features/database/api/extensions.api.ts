import { api } from '@/shared/lib/api';
import type { ExtInfo } from '@/features/database/types';

export const extensionsApi = {
  list: () =>
    api.get('/admin/schema/extensions').then(r => r.data.data.extensions as ExtInfo[]),
  enable: (name: string) => api.post(`/admin/schema/extensions/${encodeURIComponent(name)}`),
  disable: (name: string) => api.delete(`/admin/schema/extensions/${encodeURIComponent(name)}`),
};
