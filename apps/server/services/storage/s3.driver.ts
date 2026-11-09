import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ObjectCannedACL,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import { ByteRange, IStorageDriver, ObjectData, ObjectMetadata, PutObjectInput, SignedUploadInput, encodeObjectPath } from './storage.types';
import { env } from '../../config/env';

/**
 * S3-compatible driver. Works with AWS S3 as well as MinIO / Cloudflare R2 by
 * setting S3_ENDPOINT (path-style addressing is enabled when an endpoint is set).
 */
export class S3StorageDriver implements IStorageDriver {
  private client: S3Client;
  /**
   * Signs the URLs handed to clients. Presigning makes no request, so this
   * client only needs the host the URL will be fetched from: the signature
   * covers it, and one signed for the stack's internal MinIO address cannot be
   * rewritten into a public one afterwards.
   */
  private presignClient: S3Client;

  constructor() {
    this.client = S3StorageDriver.clientFor(env.S3_ENDPOINT);
    this.presignClient = env.S3_PRESIGN_ENDPOINT && env.S3_PRESIGN_ENDPOINT !== env.S3_ENDPOINT
      ? S3StorageDriver.clientFor(env.S3_PRESIGN_ENDPOINT)
      : this.client;
  }

  private static clientFor(endpoint: string): S3Client {
    return new S3Client({
      region: env.S3_REGION,
      endpoint: endpoint || undefined,
      forcePathStyle: !!endpoint,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  async put({ bucket, key, body, contentLength, contentType, visibility }: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: contentLength,
        ContentType: contentType,
        ACL: visibility === 'public' ? ObjectCannedACL.public_read : ObjectCannedACL.private,
      })
    );
  }

  async delete(bucket: string, key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  async getObject(bucket: string, key: string, range?: ByteRange): Promise<ObjectData> {
    const res = await this.client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: range ? `bytes=${range.start}-${range.end}` : undefined,
    }));
    if (!(res.Body instanceof Readable)) throw new Error('S3 returned a non-streaming response body');
    return {
      body: res.Body,
      contentLength: res.ContentLength ?? -1,
      contentType: res.ContentType,
    };
  }

  async headObject(bucket: string, key: string): Promise<ObjectMetadata> {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      contentLength: result.ContentLength ?? -1,
      contentType: result.ContentType,
    };
  }

  async getSignedDownloadUrl(bucket: string, key: string, expiresInSec: number): Promise<string> {
    return getSignedUrl(this.presignClient, new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: expiresInSec,
    });
  }

  async getSignedUploadUrl(input: SignedUploadInput): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
      }),
      { expiresIn: input.expiresInSec }
    );
  }

  publicUrl(bucket: string, key: string): string {
    const path = encodeObjectPath(key);
    if (env.S3_PUBLIC_URL) return `${env.S3_PUBLIC_URL.replace(/\/$/, '')}/${path}`;
    if (env.S3_ENDPOINT) return `${env.S3_ENDPOINT.replace(/\/$/, '')}/${bucket}/${path}`;
    return `https://${bucket}.s3.${env.S3_REGION}.amazonaws.com/${path}`;
  }
}
