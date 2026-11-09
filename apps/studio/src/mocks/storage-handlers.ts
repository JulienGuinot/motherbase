// Mock handlers for the storage parity endpoints (bucket limits, image
// transforms, resumable uploads, S3 access keys, storage policies). Kept out of
// handlers.ts so that file does not grow a section per feature; it spreads
// `storageHandlers` in once.
import { http, HttpResponse, type HttpHandler, type HttpResponseResolver } from 'msw';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

const ok = (data: unknown) => HttpResponse.json({ data });

function admin(method: Method, path: string, resolver: HttpResponseResolver): HttpHandler[] {
  return [
    http[method](`/api/admin${path}`, resolver),
    http[method](`/api/projects/:pid/admin${path}`, resolver),
  ];
}

/** A thumbnail stand-in: a square in a colour derived from the file id, so a grid of them is visibly distinct. */
function thumbnail(id: string, width: number): string {
  const hue = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}">`
    + `<rect width="100%" height="100%" fill="hsl(${hue} 55% 55%)"/>`
    + `<text x="50%" y="54%" font-family="monospace" font-size="${Math.round(width / 8)}" fill="#fff" text-anchor="middle">${width}px</text></svg>`;
}

/** In-memory TUS uploads: id -> [offset, length]. Enough for tus-js-client to run to 100%. */
const tusUploads = new Map<string, [number, number]>();
const TUS = { 'Tus-Resumable': '1.0.0' };

interface MockS3Key {
  id: string;
  accessKeyId: string;
  description: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const s3Keys: MockS3Key[] = [
  { id: 's3k-1', accessKeyId: 'MBAKDEMO0000000000AA', description: 'CI uploads', createdAt: '2026-08-01T09:00:00Z', lastUsedAt: '2026-09-28T07:30:00Z' },
];

function randomToken(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), byte => alphabet[byte % alphabet.length]).join('');
}

/** The storage settings groups, editable in memory; the generic settings mock would answer them all with the auth group. */
const storageSettings: Record<string, { label: string; description: string; fields: object[]; values: Record<string, unknown> }> = {
  'storage.provider': {
    label: 'Storage · Provider',
    description: 'Local disk or S3-compatible.',
    fields: [
      { key: 'driver', label: 'Driver', type: 'select', options: [{ value: 'local', label: 'Local disk' }, { value: 's3', label: 'S3-compatible' }], default: 'local' },
    ],
    values: { driver: 'local' },
  },
  'storage.limits': {
    label: 'Storage · Limits',
    description: 'Upload size and type constraints.',
    fields: [
      { key: 'maxUploadBytes', label: 'Max upload size (bytes)', type: 'number', default: 0 },
      { key: 'allowedMimeTypes', label: 'Allowed MIME types', type: 'text', placeholder: 'image/*, application/pdf' },
    ],
    values: { maxUploadBytes: 0, allowedMimeTypes: '' },
  },
  'storage.imageTransform': {
    label: 'Storage · Image transformations',
    description: 'Resize and convert images on the fly through /storage/v1/render/image.',
    fields: [
      { key: 'enabled', label: 'Enable image transformations', type: 'bool', default: true },
      { key: 'maxSourceBytes', label: 'Largest source image (bytes)', type: 'number', default: 26_214_400 },
    ],
    values: { enabled: true, maxSourceBytes: 26_214_400 },
  },
  'storage.policies': {
    label: 'Storage · Policies',
    description: 'Let RLS policies on storage.files decide access.',
    fields: [{ key: 'enabled', label: 'Use RLS policies for storage', type: 'bool', default: false }],
    values: { enabled: false },
  },
};

const settingsGroup = (key: string) => ({ group: key, source: 'db', ...storageSettings[key] });

export const storageHandlers: HttpHandler[] = [
  ...admin('post', '/storage/upload/resumable', ({ request }) => {
    const id = crypto.randomUUID();
    tusUploads.set(id, [0, Number(request.headers.get('upload-length')) || 0]);
    return new HttpResponse(null, { status: 201, headers: { ...TUS, Location: `resumable/${id}` } });
  }),
  ...admin('patch', '/storage/upload/resumable/:id', async ({ params, request }) => {
    const upload = tusUploads.get(String(params.id));
    if (!upload) return new HttpResponse(null, { status: 404, headers: TUS });
    upload[0] += (await request.arrayBuffer()).byteLength;
    return new HttpResponse(null, { status: 204, headers: { ...TUS, 'Upload-Offset': String(upload[0]) } });
  }),
  ...Object.keys(storageSettings).flatMap(key => [
    ...admin('get', `/settings/${key}`, () => ok(settingsGroup(key))),
    ...admin('put', `/settings/${key}`, async ({ request }) => {
      storageSettings[key].values = (await request.json()) as Record<string, unknown>;
      return ok(settingsGroup(key));
    }),
  ]),
  ...admin('get', '/storage/s3', () =>
    ok({ enabled: true, endpoint: 'http://localhost:3000/storage/v1/s3', region: 'us-east-1', forcePathStyle: true })),
  ...admin('get', '/storage/s3/keys', () => ok({ keys: s3Keys })),
  ...admin('post', '/storage/s3/keys', async ({ request }) => {
    const { description } = (await request.json()) as { description: string };
    const key: MockS3Key = {
      id: crypto.randomUUID(),
      accessKeyId: `MBAK${randomToken(16)}`,
      description,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    s3Keys.unshift(key);
    return ok({ key, secretAccessKey: randomToken(40) });
  }),
  ...admin('delete', '/storage/s3/keys/:id', ({ params }) => {
    const index = s3Keys.findIndex(key => key.id === params.id);
    if (index >= 0) s3Keys.splice(index, 1);
    return ok({});
  }),
  ...admin('patch', '/storage/buckets/:slug', () => ok({ ok: true })),
  ...admin('get', '/storage/files/:id/render', ({ params, request }) => {
    const width = Number(new URL(request.url).searchParams.get('width')) || 320;
    return new HttpResponse(thumbnail(String(params.id), width), { headers: { 'Content-Type': 'image/svg+xml' } });
  }),
];
