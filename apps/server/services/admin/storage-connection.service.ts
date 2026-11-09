import BaseContext from '../../context/base-context';
import { env } from '../../config/env';

export interface StorageConnectionInfo {
  driver: 'local' | 's3';
  /** S3-compatible endpoint (MinIO or real S3). Absent on the local driver. */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBucket: string;
}

/**
 * How to reach this project's object storage with a plain S3 client (aws-cli,
 * boto3, Cyberduck, rclone) instead of the SDK. The credentials here are the
 * S3 root key pair from S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY, not a
 * console operator's login, which MinIO has never heard of and never will.
 */
export class StorageConnectionService extends BaseContext {
  get(): StorageConnectionInfo {
    return {
      driver: env.STORAGE_DRIVER === 's3' ? 's3' : 'local',
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      bucket: env.S3_BUCKET,
      publicBucket: env.S3_PUBLIC_BUCKET,
    };
  }
}
