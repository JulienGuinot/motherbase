/**
 * The wire contract between the server's EdgeRuntimeClient, this sidecar, and
 * the worker processes it spawns. All three speak the same two shapes.
 *
 * EdgeResult is deliberately identical to the server's SandboxResult. The whole
 * point of this runtime swap is that nothing above the sandbox seam notices it,
 * so the boundary type is copied rather than reinterpreted.
 */

export interface EdgeRequestInit {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface EdgeLimits {
  memoryLimitMb: number;
  timeoutMs: number;
}

export interface EdgeSourceFile {
  path: string;
  contentBase64: string;
}

export interface EdgeSource {
  entrypointPath: string;
  files: EdgeSourceFile[];
}

/**
 * Where `sendMail()` posts. The API owns SMTP, so the worker calls back to it
 * with a token that is valid for this one invocation only.
 */
export interface EdgeMailBridge {
  url: string;
  token: string;
}

export interface EdgeJob {
  code: string;
  mail?: EdgeMailBridge;
  /** Deploy-time check: load the module, resolving its imports, but do not call it. */
  check?: boolean;
  source?: EdgeSource;
  context: Record<string, unknown>;
  env: Record<string, string>;
  request: EdgeRequestInit;
  limits: EdgeLimits;
}

export interface EdgeResult {
  value: unknown;
  stdout: string;
  error: string | null;
  durationMs: number;
  response?: { status: number; headers: Record<string, string>; body: string };
}

/** Validate and default an incoming job. Throws with a message naming the field. */
export function parseJob(raw: unknown): EdgeJob {
  const input = (raw ?? {}) as Partial<EdgeJob>;

  if (typeof input.code !== 'string' || input.code.length === 0) {
    throw new Error('code is required and must be a non-empty string');
  }

  const limits = input.limits;
  if (!limits || !isPositiveInteger(limits.memoryLimitMb)) {
    throw new Error('limits.memoryLimitMb is required and must be a positive integer');
  }
  if (!isPositiveInteger(limits.timeoutMs)) {
    throw new Error('limits.timeoutMs is required and must be a positive integer');
  }

  const request = input.request ?? ({} as Partial<EdgeRequestInit>);

  return {
    code: input.code,
    source: parseSource(input.source),
    mail: parseMail(input.mail),
    check: input.check === true,
    context: isPlainObject(input.context) ? input.context : {},
    env: isPlainObject(input.env) ? (input.env as Record<string, string>) : {},
    limits: { memoryLimitMb: limits.memoryLimitMb, timeoutMs: limits.timeoutMs },
    request: {
      method: typeof request.method === 'string' ? request.method : 'POST',
      // A scheduled run has no HTTP request of its own, but the handler
      // signature is the same either way, so it still gets a Request.
      url: typeof request.url === 'string' && request.url.length > 0 ? request.url : 'http://edge.local/',
      headers: isPlainObject(request.headers) ? (request.headers as Record<string, string>) : {},
      body: typeof request.body === 'string' ? request.body : undefined,
    },
  };
}

function parseMail(raw: unknown): EdgeMailBridge | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw) || typeof raw.url !== 'string' || typeof raw.token !== 'string' || !raw.token) {
    throw new Error('mail must contain url and token');
  }
  return { url: raw.url, token: raw.token };
}

const MAX_SOURCE_FILES = 256;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

function parseSource(raw: unknown): EdgeSource | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw) || typeof raw.entrypointPath !== 'string' || !Array.isArray(raw.files)) {
    throw new Error('source must contain entrypointPath and files');
  }
  if (raw.files.length === 0 || raw.files.length > MAX_SOURCE_FILES) {
    throw new Error(`source.files must contain between 1 and ${MAX_SOURCE_FILES} files`);
  }

  const entrypointPath = normalizeSourcePath(raw.entrypointPath);
  const seen = new Set<string>();
  let totalBytes = 0;
  const files = raw.files.map((value, index) => {
    if (!isPlainObject(value) || typeof value.path !== 'string' || typeof value.contentBase64 !== 'string') {
      throw new Error(`source.files[${index}] must contain path and contentBase64`);
    }
    const path = normalizeSourcePath(value.path);
    if (seen.has(path)) throw new Error(`source contains duplicate path: ${path}`);
    seen.add(path);
    const bytes = decodeBase64(value.contentBase64, `source.files[${index}].contentBase64`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_SOURCE_BYTES) throw new Error('source files exceed the 20 MB limit');
    return { path, contentBase64: value.contentBase64 };
  });

  if (!seen.has(entrypointPath)) throw new Error('source.entrypointPath must reference an included file');
  return { entrypointPath, files };
}

function normalizeSourcePath(value: string): string {
  const path = value.trim().replace(/^\.\//, '');
  if (!path || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new Error(`invalid source path: ${value}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`invalid source path: ${value}`);
  }
  return path;
}

function decodeBase64(value: string, field: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    if (base64(bytes).replace(/=+$/, '') !== value.replace(/=+$/, '')) throw new Error();
    return bytes;
  } catch {
    throw new Error(`${field} must be valid base64`);
  }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
