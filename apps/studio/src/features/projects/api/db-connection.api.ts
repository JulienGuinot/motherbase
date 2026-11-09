import { api } from '@/shared/lib/api';

export interface DbConnectionInfo {
  user: string;
  database: string;
  password: string;
  internalHost: string;
  internalPort: number;
  /** Host port the database is published on, or null when none was allocated. */
  hostPort: number | null;
  bind: string;
  publiclyBound: boolean;
  internalUri: string;
}

export const dbConnectionApi = {
  get: () => api.get('/admin/database/connection').then(r => r.data.data as DbConnectionInfo),
};
