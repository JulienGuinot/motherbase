import { isAxiosError } from 'axios';

// Every error the Studio shows a user passes through here. The raw material is
// one of three things, and only the first is already fit to display:
//
//   1. The API error envelope ({ status: 0, code, message }) built by the
//      server's api-error middleware. Its message is written for humans.
//   2. An HTTP response with no usable envelope: a proxy/gateway page (the
//      console reverse-proxy returns HTML on 502), an empty body, or a
//      non-string message. Axios then leaves only "Request failed with status
//      code 502", which tells the user nothing they can act on.
//   3. No response at all: offline, DNS/connection refused, timeout, abort.
//      Axios reports these as the famously unhelpful "Network Error".
//
// Cases 2 and 3 get a plain-language sentence plus, where one exists, the
// single next step that resolves it.

interface ApiErrorBody {
  message?: unknown;
  error?: unknown;
  errors?: unknown;
  code?: unknown;
  hint?: unknown;
  detail?: unknown;
}

export interface ErrorInfo {
  /** Human sentence, never empty. Safe to render directly. */
  message: string;
  /** Server error code from the envelope (e.g. PASSWORD_CHANGE_REQUIRED). */
  code?: string;
  /** HTTP status, when the request reached a server. */
  status?: number;
  /** One actionable next step, when the status or code implies one. */
  hint?: string;
  /** Parsed Retry-After, in seconds, for 429 responses. */
  retryAfterSeconds?: number;
  /** True when the request never got a response (offline, refused, timeout). */
  offline: boolean;
}

const DEFAULT_FALLBACK = 'Request failed';

/** Status responses whose body carries no usable message of its own. */
const STATUS_MESSAGES: Record<number, string> = {
  400: 'The request was rejected as invalid.',
  401: 'Your session is no longer valid.',
  403: 'You do not have permission to do this.',
  404: 'That resource no longer exists.',
  405: 'That operation is not supported here.',
  409: 'This conflicts with something that already exists.',
  413: 'The upload is larger than the server accepts.',
  415: 'The server does not accept that file type.',
  422: 'The request was understood but the values were rejected.',
  429: 'Too many requests in a short time.',
  500: 'The server hit an unexpected error.',
  501: 'That operation is not implemented on this server.',
  502: 'The project API did not respond.',
  503: 'The service is unavailable right now.',
  504: 'The server took too long to respond.',
};

const STATUS_HINTS: Record<number, string> = {
  401: 'Sign in again to continue.',
  403: 'Check your console role, or ask an owner to grant access.',
  409: 'Reload to see the current state, then retry.',
  413: 'Use a smaller file, or raise the upload limit in storage settings.',
  429: 'Wait a moment and retry.',
  500: 'Check the project logs for the failing request.',
  502: 'The project container may be starting or stopped. Check that the project is running, then retry.',
  503: 'The project container may be starting or stopped. Check that the project is running, then retry.',
  504: 'The operation may still be running on the server. Check before retrying.',
};

/** Codes the server sends that deserve a clearer sentence than their message. */
const CODE_HINTS: Record<string, string> = {
  PASSWORD_CHANGE_REQUIRED: 'You must set a new password before continuing.',
  RATE_LIMITED: 'Wait a moment and retry.',
};

/**
 * Reduce any thrown value to the parts worth showing a user. Prefer this over
 * getErrorMessage when the surface can render a hint separately from the
 * message (an inline form error, a detail panel).
 */
export function describeError(error: unknown, fallback = DEFAULT_FALLBACK): ErrorInfo {
  if (isAxiosError<ApiErrorBody>(error)) {
    const response = error.response;

    // No response: the request never reached a server.
    if (!response) return offlineInfo(error);

    const status = response.status;
    const body = response.data;
    const code = typeof body?.code === 'string' ? body.code : undefined;
    const serverMessage = extractServerMessage(body);
    const retryAfterSeconds = parseRetryAfter(response.headers?.['retry-after']);

    const message = serverMessage ?? STATUS_MESSAGES[status] ?? `${fallback} (HTTP ${status}).`;
    const hint =
      (code ? CODE_HINTS[code] : undefined) ??
      (status === 429 && retryAfterSeconds
        ? `Retry in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`
        : STATUS_HINTS[status]);

    return { message, code, status, hint, retryAfterSeconds, offline: false };
  }

  if (error instanceof Error && error.message.trim()) {
    return { message: error.message.trim(), offline: false };
  }
  if (typeof error === 'string' && error.trim()) {
    return { message: error.trim(), offline: false };
  }
  return { message: fallback, offline: false };
}

/**
 * The one-string form, used by toasts and inline error text. The hint is folded
 * in only when the message alone leaves the user with nothing to do (that is,
 * when the server sent no message of its own).
 */
export function getErrorMessage(error: unknown, fallback = DEFAULT_FALLBACK): string {
  const info = describeError(error, fallback);
  const serverSpoke = info.status !== undefined && info.message !== STATUS_MESSAGES[info.status];
  if (info.hint && !serverSpoke) return `${info.message} ${info.hint}`;
  return info.message;
}

// ── internals ────────────────────────────────────────────────────────────────

function offlineInfo(error: { code?: string; message?: string }): ErrorInfo {
  if (error.code === 'ERR_CANCELED') {
    return { message: 'The request was cancelled.', offline: true };
  }
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
    return {
      message: 'The server did not respond in time.',
      hint: 'It may still be processing. Check the result before retrying.',
      offline: true,
    };
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return {
      message: 'You appear to be offline.',
      hint: 'Reconnect and retry.',
      offline: true,
    };
  }
  return {
    message: 'Could not reach the server.',
    hint: 'Check your connection and that the backend is running, then retry.',
    offline: true,
  };
}

/**
 * Pull a displayable message out of an error body. Rejects HTML (proxy error
 * pages arrive as a full document) and anything that is not real prose, so the
 * caller falls through to the status sentence instead of rendering markup.
 */
function extractServerMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return cleanMessage(body);
  if (!body || typeof body !== 'object') return undefined;

  const record = body as ApiErrorBody;
  const direct = firstString([record.message, record.error, record.detail]);
  if (direct) return direct;

  // A nested { error: { message } } shape, as some upstream services return.
  if (record.error && typeof record.error === 'object') {
    const nested = firstString([(record.error as ApiErrorBody).message]);
    if (nested) return nested;
  }

  // Validation failures arrive as a list; join them so no field is hidden.
  if (Array.isArray(record.errors)) {
    const parts = record.errors
      .map(item =>
        typeof item === 'string'
          ? cleanMessage(item)
          : firstString([(item as ApiErrorBody)?.message])
      )
      .filter((part): part is string => Boolean(part));
    if (parts.length > 0) return parts.join('. ');
  }

  return undefined;
}

function firstString(candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const cleaned = cleanMessage(candidate);
      if (cleaned) return cleaned;
    }
  }
  return undefined;
}

function cleanMessage(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  // Proxy and framework error pages: never show markup to a user.
  if (/^<[a-z!]/i.test(value)) return undefined;
  // Guard against a whole stack trace or dumped payload landing in a toast.
  if (value.length > 400) return `${value.slice(0, 400).trimEnd()}...`;
  return value;
}

function parseRetryAfter(header: unknown): number | undefined {
  if (typeof header !== 'string' && typeof header !== 'number') return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(String(header));
  if (Number.isNaN(date)) return undefined;
  const delta = Math.ceil((date - Date.now()) / 1000);
  return delta > 0 ? delta : undefined;
}
