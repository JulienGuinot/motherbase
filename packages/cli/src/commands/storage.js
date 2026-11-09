'use strict';

// Storage in the Supabase CLI's shape: objects are addressed `ss:///bucket/key`
// and `ls|cp|mv|rm` take `-r` for a whole prefix. The pre-Supabase forms still
// work: `cp ./a.png bucket:` uploads, `cp <fileId> ./a.png` downloads and
// `rm <fileId>` deletes by id.

const fs = require('fs');
const path = require('path');
const api = require('../api');
const { output, requireArg, splitRef, resolveInside } = require('./_util');
const { CliError } = require('../context');
const remote = require('../storage/remote');

const PAGE = 1000;

const objectPath = (bucket, key) => `/storage/buckets/${encodeURIComponent(bucket)}/objects/${remote.encodeKey(key)}`;

/** Every key under a prefix, paged through the server's 1000-row limit. */
async function listKeys(ctx, bucket, prefix) {
  const keys = [];
  for (let offset = 0; ; offset += PAGE) {
    const data = await api.adminRequest(ctx, 'GET', `/storage/buckets/${encodeURIComponent(bucket)}/objects`, {
      query: { prefix: prefix || undefined, limit: PAGE, offset },
    });
    const page = (data && data.objects) || [];
    keys.push(...page.map(o => o.name));
    if (page.length < PAGE) return keys;
  }
}

/** Files under a local directory, as paths relative to it with `/` separators. */
function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, base);
    return entry.isFile() ? [path.relative(base, full).split(path.sep).join('/')] : [];
  });
}

/**
 * Run one request per object, in order. The first failure stops the batch and
 * says how far it got, so a partial copy or delete is never reported as done.
 */
async function each(items, label, fn) {
  const done = [];
  for (const item of items) {
    try {
      await fn(item);
    } catch (err) {
      throw new CliError(`${label} failed on ${item} after ${done.length} of ${items.length}: ${err.message}`);
    }
    done.push(item);
  }
  return done;
}

/** The keys an operation on `key` touches: the one object, or everything under it with -r. */
async function sourceKeys(ctx, { bucket, key }, recursive) {
  if (!recursive) {
    if (!key) throw new CliError('Name an object, or pass -r to act on a whole prefix.');
    return [key];
  }
  const keys = await listKeys(ctx, bucket, remote.asPrefix(key));
  if (!keys.length) throw new CliError(`No objects under ss:///${bucket}/${remote.asPrefix(key)}`);
  return keys;
}

/** Remote-to-remote copy or move: same bucket, since both routes are bucket-scoped. */
async function transfer(ctx, action, srcArg, dstArg, recursive) {
  const src = remote.requireBucket(remote.parseRemote(srcArg), srcArg);
  const dst = remote.requireBucket(remote.parseRemote(dstArg), dstArg);
  if (src.bucket !== dst.bucket) {
    throw new CliError(`${action} works within one bucket: ${src.bucket} and ${dst.bucket} differ.`);
  }
  const keys = await sourceKeys(ctx, src, recursive);
  const target = key => (recursive
    ? remote.rebase(key, remote.asPrefix(src.key), remote.asPrefix(dst.key))
    : remote.destinationKey(dst.key, key));
  // cp overwrites as it does locally; mv refuses to, as Supabase's does.
  const upsert = action === 'copy';
  return each(keys, action, key =>
    api.adminRequest(ctx, 'POST', `/storage/buckets/${encodeURIComponent(src.bucket)}/${action}`, {
      body: { from: key, to: target(key), upsert },
    }),
  );
}

async function upload(ctx, srcArg, dstArg, recursive) {
  const dst = remote.requireBucket(remote.parseRemote(dstArg), dstArg);
  const local = path.resolve(ctx.cwd, srcArg);
  const upsert = 'true';
  if (fs.statSync(local).isDirectory()) {
    if (!recursive) throw new CliError(`${srcArg} is a directory: pass -r to upload it.`);
    const prefix = remote.asPrefix(dst.key);
    return each(walk(local), 'upload', rel =>
      api.uploadFile(ctx, '/storage/files', path.join(local, rel), { bucket: dst.bucket, path: prefix + rel, upsert }),
    );
  }
  const key = remote.destinationKey(dst.key, local);
  return each([key], 'upload', () => api.uploadFile(ctx, '/storage/files', local, { bucket: dst.bucket, path: key, upsert }));
}

async function download(ctx, srcArg, dstArg, recursive) {
  const src = remote.requireBucket(remote.parseRemote(srcArg), srcArg);
  const local = path.resolve(ctx.cwd, dstArg);
  if (recursive) {
    const prefix = remote.asPrefix(src.key);
    const keys = await sourceKeys(ctx, src, true);
    return each(keys, 'download', key => {
      const target = resolveInside(local, ...key.slice(prefix.length).split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      return api.downloadFile(ctx, objectPath(src.bucket, key), target);
    });
  }
  const [key] = await sourceKeys(ctx, src, false);
  const intoDir = dstArg.endsWith('/') || dstArg.endsWith(path.sep) || (fs.existsSync(local) && fs.statSync(local).isDirectory());
  const target = intoDir ? path.join(local, path.basename(key)) : local;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return each([key], 'download', () => api.downloadFile(ctx, objectPath(src.bucket, key), target));
}

// The id-addressed forms that predate `ss://` paths.
async function legacyCopy(ctx, src, dst, flags) {
  if (fs.existsSync(path.resolve(ctx.cwd, src))) {
    const { bucket } = splitRef(dst);
    const fields = { bucket, visibility: flags.visibility };
    const data = await api.uploadFile(ctx, '/storage/files', path.resolve(ctx.cwd, src), fields);
    return output(ctx, data, (d, ui) => ui.success(`Uploaded ${src}${d && d.id ? ` → ${d.id}` : ''}`));
  }
  const { rest } = splitRef(src);
  const fileId = rest || src;
  const res = await api.downloadFile(ctx, `/storage/files/${fileId}/raw`, path.resolve(ctx.cwd, dst));
  return output(ctx, res, (d, ui) => ui.success(`Downloaded ${fileId} → ${dst}`));
}

const reportDone = (verb, count) => (_d, ui) => ui.success(`${verb} ${count} object${count === 1 ? '' : 's'}`);

const buckets = {
  summary: 'Manage storage buckets',
  usage: 'motherbase storage buckets <list|create|delete> ...',
  subcommands: {
    list: {
      summary: 'List buckets',
      usage: 'motherbase storage buckets list',
      async run(ctx) {
        const data = await api.adminRequest(ctx, 'GET', '/storage/buckets');
        const rows = Array.isArray(data) ? data : (data && data.buckets) || [];
        output(ctx, data, (_d, ui) =>
          ui.table(rows, [
            { key: 'slug', label: 'SLUG' },
            { key: 'name', label: 'NAME' },
            { key: 'visibility', label: 'VISIBILITY' },
          ]),
        );
      },
    },
    create: {
      summary: 'Create a bucket',
      usage:
        'motherbase storage buckets create <slug> [--name n] [--visibility public|private]'
        + ' [--file-size-limit 20MB] [--allowed-mime-types image/*,application/pdf]',
      async run(ctx, args, flags) {
        const slug = requireArg(args[0], 'slug');
        const body = { slug, name: flags.name || slug };
        if (flags.visibility) body.visibility = flags.visibility;
        // Passed through as typed: the server reads "20MB" as well as a byte count.
        if (flags['file-size-limit']) body.fileSizeLimit = flags['file-size-limit'];
        if (flags['allowed-mime-types']) body.allowedMimeTypes = String(flags['allowed-mime-types']).split(',');
        const data = await api.adminRequest(ctx, 'POST', '/storage/buckets', { body });
        output(ctx, data, (d, ui) => ui.success(`Created bucket ${slug}`));
      },
    },
    delete: {
      summary: 'Delete a bucket',
      usage: 'motherbase storage buckets delete <slug> [--force]',
      async run(ctx, args, flags) {
        const slug = requireArg(args[0], 'slug');
        const query = flags.force ? { force: 'true' } : undefined;
        const data = await api.adminRequest(ctx, 'DELETE', `/storage/buckets/${slug}`, { query });
        output(ctx, data, (d, ui) => ui.success(`Deleted bucket ${slug}`));
      },
    },
  },
};

const subcommands = {
  buckets,
  ls: {
    summary: 'List buckets, or the objects under a path',
    usage: 'motherbase storage ls [ss:///bucket/prefix] [-r]',
    async run(ctx, args, flags) {
      const arg = args[0] || remote.SCHEME;
      // A bare bucket name is the pre-`ss://` form of the same request.
      const { bucket, key } = remote.parseRemote(remote.isRemote(arg) ? arg : `${remote.SCHEME}${arg}`);
      if (!bucket) {
        const data = await api.adminRequest(ctx, 'GET', '/storage/buckets');
        const slugs = (Array.isArray(data) ? data : []).map(b => `${b.slug}/`);
        return output(ctx, { entries: slugs }, (d, ui) => d.entries.forEach(e => ui.print(e)));
      }
      const prefix = remote.asPrefix(key);
      const keys = await listKeys(ctx, bucket, prefix);
      const entries = flags.recursive ? keys : remote.childrenOf(keys, prefix);
      output(ctx, { bucket, prefix, entries }, (d, ui) => d.entries.forEach(e => ui.print(e)));
    },
  },
  cp: {
    summary: 'Copy between local paths and ss:///bucket/key (upload, download or in-bucket copy)',
    usage: 'motherbase storage cp <src> <dst> [-r]   e.g. cp ./a.png ss:///media/  |  cp -r ss:///media/img ./img',
    async run(ctx, args, flags) {
      const src = requireArg(args[0], 'src');
      const dst = requireArg(args[1], 'dst');
      const recursive = Boolean(flags.recursive);
      let done;
      if (remote.isRemote(src) && remote.isRemote(dst)) done = await transfer(ctx, 'copy', src, dst, recursive);
      else if (remote.isRemote(dst)) done = await upload(ctx, src, dst, recursive);
      else if (remote.isRemote(src)) done = await download(ctx, src, dst, recursive);
      else return legacyCopy(ctx, src, dst, flags);
      output(ctx, { copied: done }, reportDone('Copied', done.length));
    },
  },
  mv: {
    summary: 'Move objects within a bucket',
    usage: 'motherbase storage mv <ss:///bucket/src> <ss:///bucket/dst> [-r]',
    async run(ctx, args, flags) {
      const src = requireArg(args[0], 'src');
      const dst = requireArg(args[1], 'dst');
      if (!remote.isRemote(src) || !remote.isRemote(dst)) {
        throw new CliError('mv moves objects: both paths must be ss:///bucket/key.');
      }
      const done = await transfer(ctx, 'move', src, dst, Boolean(flags.recursive));
      output(ctx, { moved: done }, reportDone('Moved', done.length));
    },
  },
  rm: {
    summary: 'Delete objects by path (or a file by id)',
    usage: 'motherbase storage rm <ss:///bucket/key | fileId>... [-r]',
    async run(ctx, args, flags) {
      requireArg(args[0], 'path');
      const removed = [];
      for (const arg of args) {
        if (!remote.isRemote(arg)) {
          await api.adminRequest(ctx, 'DELETE', `/storage/files/${encodeURIComponent(arg)}`);
          removed.push(arg);
          continue;
        }
        const target = remote.requireBucket(remote.parseRemote(arg), arg);
        const keys = await sourceKeys(ctx, target, Boolean(flags.recursive));
        const done = await each(keys, 'rm', key => api.adminRequest(ctx, 'DELETE', objectPath(target.bucket, key)));
        removed.push(...done.map(key => `${target.bucket}/${key}`));
      }
      output(ctx, { removed }, reportDone('Deleted', removed.length));
    },
  },
};

module.exports = {
  summary: 'Storage buckets and objects (ss:///bucket/key paths)',
  usage: 'motherbase storage <buckets|ls|cp|mv|rm> ...',
  subcommands,
};
