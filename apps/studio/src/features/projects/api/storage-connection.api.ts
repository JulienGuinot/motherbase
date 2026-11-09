import { api } from '@/shared/lib/api';

export interface StorageConnectionInfo {
  driver: 'local' | 's3';
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBucket: string;
}

export const storageConnectionApi = {
  get: () => api.get('/admin/storage/connection').then(r => r.data.data as StorageConnectionInfo),
};
