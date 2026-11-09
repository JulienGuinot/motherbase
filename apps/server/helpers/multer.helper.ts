import { createReadStream, type ReadStream } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Readable } from 'stream';
import multer from 'multer';
import { env } from '../config/env';

const AVATAR_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const TEMP_UPLOAD_DIRECTORY = path.join(os.tmpdir(), `motherbase-uploads-${randomUUID()}`);

const temporaryStorage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    void fs.mkdir(TEMP_UPLOAD_DIRECTORY, { recursive: true, mode: 0o700 }).then(
      () => callback(null, TEMP_UPLOAD_DIRECTORY),
      error => callback(error, '')
    );
  },
  filename: (_req, _file, callback) => callback(null, randomUUID()),
});

const temporaryUploader = (fileFilter?: multer.Options['fileFilter']) =>
  multer({
    storage: temporaryStorage,
    limits: { fileSize: env.MAX_UPLOAD_BYTES },
    fileFilter,
  });

/** Multipart uploads are spooled to a private temporary file, never held in RAM. */
export const streamUpload = temporaryUploader();

/**
 * Uploading a backup file back into BACKUP_DIR: same disk spooling, its own
 * size ceiling. A dump is routinely larger than MAX_UPLOAD_MB, which exists to
 * bound tenant uploads and should not be raised to make room for one admin
 * route.
 */
export const backupUpload = multer({
  storage: temporaryStorage,
  limits: { fileSize: env.MAX_BACKUP_UPLOAD_BYTES },
});

/** Public avatar uploads accept image formats only. */
export const imageUpload = temporaryUploader((_req, file, callback) => {
  callback(null, AVATAR_MIMETYPES.has(file.mimetype));
});

/**
 * The stream each upload's temporary file was opened with. createReadStream
 * opens asynchronously, so a consumer that fails before reading (a rejected
 * upload, a thrown validation) leaves an open pending while the controller's
 * finally unlinks the file. The open then fails with ENOENT on a stream nobody
 * listens to, which is an uncaught exception that takes the process down.
 */
const openedSources = new WeakMap<Express.Multer.File, ReadStream>();

export interface UploadedFileSource {
  body: Readable;
  size: number;
}

/** Open Multer's temporary file as a backpressure-aware source stream. */
export function uploadedFileSource(file: Express.Multer.File): UploadedFileSource {
  if (!file.path) throw new Error('Multipart upload is missing its temporary file');
  const body = createReadStream(file.path);
  openedSources.set(file, body);
  return { body, size: file.size };
}

/** Always call from a controller finally block after consuming the upload. */
export async function removeUploadedFile(file?: Express.Multer.File): Promise<void> {
  if (!file?.path) return;
  // Closed before the unlink: destroying does not cancel an open in flight, it
  // only closes once the open lands, so the file has to still be there by then.
  const stream = openedSources.get(file);
  if (stream && !stream.closed) {
    const closed = new Promise<void>(resolve => stream.once('close', () => resolve()));
    stream.destroy();
    await closed;
  }
  try {
    await fs.unlink(file.path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      console.error('[upload] failed to remove temporary file:', error);
    }
  }
}
