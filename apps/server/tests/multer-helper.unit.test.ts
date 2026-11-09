import { mkdtemp, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeUploadedFile, uploadedFileSource } from '../helpers/multer.helper';

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('upload temporary files', () => {
  it('removes a file whose stream was never read without an ENOENT on that stream', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'multer-helper-'));
    const filePath = path.join(dir, 'upload');
    await writeFile(filePath, 'x');
    const file = { path: filePath, size: 1 } as Express.Multer.File;

    // What a controller does when the storage call rejects before reading.
    const { body } = uploadedFileSource(file);
    const onError = vi.fn();
    body.on('error', onError);
    await removeUploadedFile(file);

    expect(body.closed).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
