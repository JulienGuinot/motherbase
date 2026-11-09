'use client';

import { useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import type { FileVisibility, MotherbaseClient, UploadOptions, UploadResult } from '@motherbase/client';
import { useAuth, useMotherbaseClient } from './context.js';
import { UserAvatar } from './avatar.js';
import type { UserAvatarProps } from './avatar.js';
import { classes, Notice, useFormAction } from './shared.js';

export type UploadClassNames = Partial<Record<'dropzone' | 'list' | 'message', string>>;

const rejectionLabels = {
  notAccepted: (name: string) => `${name} is not an accepted file type.`,
  tooLarge: (name: string, maxSize: number) => `${name} is larger than ${Math.round(maxSize / 1024)} KB.`,
};

const uploadLabels = {
  prompt: 'Drop a file here or click to browse',
  uploading: 'Uploading…',
  uploaded: (name: string) => `${name} uploaded.`,
  done: 'Uploaded',
  tooMany: (max: number) => `Only ${max} files at a time.`,
  ...rejectionLabels,
};

const avatarUploadLabels = {
  change: 'Change photo',
  uploading: 'Uploading…',
  ...rejectionLabels,
};

export type FileRejectionLabels = typeof rejectionLabels;
export type UploadLabels = typeof uploadLabels;
export type AvatarUploadLabels = typeof avatarUploadLabels;

export interface UploadFieldProps {
  /** Pass a client, or wrap the tree in `MotherbaseProvider`. */
  client?: MotherbaseClient;
  bucket: string;
  /** Object key for a file. Defaults to the file name. */
  path?: (file: File) => string;
  /** Same syntax as `<input accept>`: `image/*`, `application/pdf`, `.csv`. Also enforced on drop. */
  accept?: string;
  /** Bytes. */
  maxSize?: number;
  visibility?: FileVisibility;
  /** Replace an object that already exists at the same key. */
  upsert?: boolean;
  disabled?: boolean;
  className?: string;
  classNames?: UploadClassNames;
  labels?: Partial<UploadLabels>;
}

/** `<input accept>` rules, applied by hand because dropped files skip the picker's filter. */
export function acceptsFile(file: Pick<File, 'name' | 'type'>, accept?: string): boolean {
  const rules = (accept ?? '').split(',').map(rule => rule.trim().toLowerCase()).filter(Boolean);
  if (rules.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return rules.some(rule => rule.startsWith('.') ? name.endsWith(rule) : rule.endsWith('/*') ? type.startsWith(rule.slice(0, -1)) : type === rule);
}

/** Why a file cannot be uploaded, or `null` if it can. */
export function rejectFile(
  file: Pick<File, 'name' | 'type' | 'size'>,
  { accept, maxSize }: Pick<UploadFieldProps, 'accept' | 'maxSize'>,
  labels?: Partial<FileRejectionLabels>,
): string | null {
  const text = { ...rejectionLabels, ...labels };
  if (!acceptsFile(file, accept)) return text.notAccepted(file.name);
  if (maxSize !== undefined && file.size > maxSize) return text.tooLarge(file.name, maxSize);
  return null;
}

function uploadOptions({ visibility, upsert }: UploadFieldProps): UploadOptions {
  return { visibility, upsert };
}

function Dropzone({ multiple, accept, disabled, onFiles, className, children }: {
  multiple?: boolean;
  accept?: string;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  className?: string;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);

  function pick(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (files.length > 0) onFiles(multiple ? files : files.slice(0, 1));
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    setOver(false);
    if (!disabled) pick(event.dataTransfer.files);
  }

  return <label
    className={classes('mbui-dropzone', className)}
    data-over={over || undefined}
    data-disabled={disabled || undefined}
    onDragOver={event => { event.preventDefault(); if (!disabled) setOver(true); }}
    onDragLeave={() => setOver(false)}
    onDrop={drop}
  >
    <input type="file" className="mbui-visually-hidden" multiple={multiple} accept={accept} disabled={disabled}
      onChange={event => { pick(event.target.files); event.target.value = ''; }} />
    {children}
  </label>;
}

export function FileUpload({ onUploaded, ...props }: UploadFieldProps & {
  onUploaded?: (result: UploadResult, file: File) => void;
}) {
  const client = useMotherbaseClient(props.client);
  const { busy, error, setError, run } = useFormAction();
  const [uploaded, setUploaded] = useState<string | null>(null);
  const text = { ...uploadLabels, ...props.labels };

  async function send([file]: File[]) {
    setUploaded(null);
    const problem = rejectFile(file, props, text);
    if (problem) return setError(problem);
    const result = await run(() => client.storage.from(props.bucket).upload(props.path?.(file) ?? file.name, file, uploadOptions(props)));
    if (result?.data) {
      setUploaded(file.name);
      onUploaded?.(result.data, file);
    }
  }

  return <div className={classes('mbui mbui-stack', props.className)}>
    <Dropzone accept={props.accept} disabled={busy || props.disabled} onFiles={files => void send(files)} className={props.classNames?.dropzone}>
      {busy ? text.uploading : text.prompt}
    </Dropzone>
    <Notice error className={props.classNames?.message}>{error}</Notice>
    <Notice className={props.classNames?.message}>{uploaded && text.uploaded(uploaded)}</Notice>
  </div>;
}

interface UploadEntry {
  path: string;
  name: string;
  status: 'uploading' | 'done' | 'error';
  error?: string;
}

export function FilesUpload({ onUploaded, maxFiles, ...props }: UploadFieldProps & {
  maxFiles?: number;
  /** Called once per batch with the files that were stored. */
  onUploaded?: (results: UploadResult[]) => void;
}) {
  const client = useMotherbaseClient(props.client);
  const { busy, error, run } = useFormAction();
  const [entries, setEntries] = useState<UploadEntry[]>([]);
  const text = { ...uploadLabels, prompt: 'Drop files here or click to browse', ...props.labels };

  async function send(files: File[]) {
    const queued: Array<{ file: File; path: string }> = [];
    const rejected: UploadEntry[] = [];
    for (const file of files) {
      const path = props.path?.(file) ?? file.name;
      const problem = maxFiles !== undefined && queued.length >= maxFiles ? text.tooMany(maxFiles) : rejectFile(file, props, text);
      if (problem) rejected.push({ path, name: file.name, status: 'error', error: problem });
      else queued.push({ file, path });
    }
    setEntries([...rejected, ...queued.map(({ file, path }) => ({ path, name: file.name, status: 'uploading' as const }))]);

    const result = await run(() => client.storage.from(props.bucket).uploadMany(
      queued.map(({ file, path }) => ({ path, file, options: uploadOptions(props) })),
      { onProgress: ({ path, error: failure }) => setEntries(current => current.map(entry => entry.path === path && entry.status === 'uploading'
        ? { ...entry, status: failure ? 'error' : 'done', error: failure ?? undefined }
        : entry)) },
    ));
    if (result?.data) onUploaded?.(result.data.flatMap(entry => entry.data ?? []));
  }

  return <div className={classes('mbui mbui-stack', props.className)}>
    <Dropzone multiple accept={props.accept} disabled={busy || props.disabled} onFiles={files => void send(files)} className={props.classNames?.dropzone}>
      {busy ? text.uploading : text.prompt}
    </Dropzone>
    <Notice error className={props.classNames?.message}>{error}</Notice>
    {entries.length > 0 && <ul className={classes('mbui-item-list', props.classNames?.list)}>
      {entries.map(entry => <li key={entry.path}>
        <span>{entry.name}</span>
        <span className={entry.status === 'error' ? 'mbui-notice-error' : 'mbui-description'}>
          {entry.status === 'uploading' ? text.uploading : entry.status === 'done' ? text.done : entry.error}
        </span>
      </li>)}
    </ul>}
  </div>;
}

export interface AvatarUploadProps {
  /** Must be a public bucket: the URL is stored on the user and has to keep working. Default `avatars`. */
  bucket?: string;
  /** Object key. Defaults to `<user id>/avatar`, replaced on each upload. */
  path?: (user: { id: string }, file: File) => string;
  /** Bytes. Default 2 MB. */
  maxSize?: number;
  /** Forwarded to the avatar: `size`, `fallback`... */
  avatar?: Omit<UserAvatarProps, 'user' | 'src'>;
  onChange?: (url: string) => void;
  className?: string;
  labels?: Partial<AvatarUploadLabels>;
}

/** Uploads a picture, then stores its URL as the signed-in user's `image`. */
export function AvatarUpload({ bucket = 'avatars', path, maxSize = 2 * 1024 * 1024, avatar, onChange, className, labels }: AvatarUploadProps) {
  const { client, user } = useAuth();
  const { busy, error, setError, run } = useFormAction();
  if (!user) return null;
  const text = { ...avatarUploadLabels, ...labels };

  async function send([file]: File[]) {
    const problem = rejectFile(file, { accept: 'image/*', maxSize }, text);
    if (problem) return setError(problem);
    const key = path?.(user!, file) ?? `${user!.id}/avatar`;
    const objects = client.storage.from(bucket);
    if (!await run(() => objects.upload(key, file, { visibility: 'public', upsert: true }))) return;
    // Same key every time, so the query string is what busts the browser cache.
    const url = `${objects.getPublicUrl(key).data.publicUrl}?v=${Date.now()}`;
    // updateUser refreshes the stored session, which updates the provider's user.
    if (await run(() => client.auth.updateUser({ image: url }))) onChange?.(url);
  }

  return <div className={classes('mbui mbui-avatar-upload', className)}>
    <Dropzone accept="image/*" disabled={busy} onFiles={files => void send(files)} className="mbui-avatar-upload-trigger">
      <UserAvatar user={user} size={56} {...avatar} />
      <span className="mbui-text-button">{busy ? text.uploading : text.change}</span>
    </Dropzone>
    <Notice error>{error}</Notice>
  </div>;
}
