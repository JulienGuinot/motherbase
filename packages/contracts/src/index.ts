export const HTTP_ROUTES = {
  auth: '/api/auth',
  authAdmin: '/api/auth/admin',
  authSignIn: '/api/auth/sign-in/email',
  authSession: '/api/auth/get-session',
  authSignOut: '/api/auth/sign-out',
  authSignUp: '/api/auth/sign-up/email',
  authRequestPasswordReset: '/api/auth/email-otp/request-password-reset',
  authResetPassword: '/api/auth/email-otp/reset-password',
  authSendOtp: '/api/auth/email-otp/send-verification-otp',
  authSignInEmailOtp: '/api/auth/sign-in/email-otp',
  authSignInSocial: '/api/auth/sign-in/social',
  authUpdateUser: '/api/auth/update-user',
  authChangePassword: '/api/auth/change-password',
  authDeleteUser: '/api/auth/delete-user',
  /** Better Auth account linking: the identities behind one user. */
  authListAccounts: '/api/auth/list-accounts',
  authLinkSocial: '/api/auth/link-social',
  authUnlinkAccount: '/api/auth/unlink-account',
  /** jwt plugin: mints a signed JWT for the current session (`auth.getClaims()`). */
  authToken: '/api/auth/token',
  /** phoneNumber plugin: SMS one-time codes (`signInWithOtp({ phone })`). */
  authSendPhoneOtp: '/api/auth/phone-number/send-otp',
  authVerifyPhoneOtp: '/api/auth/phone-number/verify',
  /** anonymous plugin: `signInAnonymously()`. */
  authSignInAnonymous: '/api/auth/sign-in/anonymous',
  /** GoTrue `/reauthenticate` and `PUT /user` (email/password), see auth/plugins/user-credentials.ts. */
  authReauthenticate: '/api/auth/reauthenticate',
  authUpdateUserCredentials: '/api/auth/update-user-credentials',
  /** PKCE: trade the `?code=` an OAuth callback left for a session (`exchangeCodeForSession`). */
  authExchangeCode: '/api/auth/exchange-code',
  files: '/api/files',
  storage: '/api/storage',
  /** Supabase-shaped storage surfaces: image render, resumable (TUS) uploads, the S3 protocol. */
  storageV1: '/storage/v1',
  rest: '/rest/v1',
  edge: '/api/edge',
  realtimeBroadcast: '/realtime/v1/api/broadcast',
} as const;

export type RealtimeMutation = 'created' | 'updated' | 'deleted';

export const REALTIME_SOCKET_EVENTS = {
  subscribe: 'realtime:subscribe',
  unsubscribe: 'realtime:unsubscribe',
} as const;

const REALTIME_MODEL = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** Canonical model name shared by REST mutation events and Socket.IO rooms. */
export function normalizeRealtimeModel(model: string): string | null {
  const normalized = model.trim().toLowerCase();
  return REALTIME_MODEL.test(normalized) ? normalized : null;
}

export const contractPath = {
  edge: (name: string) => `${HTTP_ROUTES.edge}/${encodeURIComponent(name)}`,
  file: (id: string, action?: 'raw' | 'url') =>
    `${HTTP_ROUTES.files}/${encodeURIComponent(id)}${action ? `/${action}` : ''}`,
  publicFile: (bucket: string, path: string) =>
    `${HTTP_ROUTES.storage}/${encodeURIComponent(bucket)}/files/${encodeURIComponent(path)}`,
  rest: (model: string) => `${HTTP_ROUTES.rest}/${encodeURIComponent(model)}`,
  realtime: (model: string, mutation: RealtimeMutation) => `${model.toLowerCase()}:${mutation}`,
} as const;

export interface AuthUserContract {
  id: string;
  email: string;
}

export interface AuthSessionContract {
  token: string;
  user: AuthUserContract;
}

export interface FileContract {
  id: string;
}

export interface StorageUploadContract<TFile extends FileContract = FileContract> {
  file: TFile;
  /** Null when the uploader has INSERT permission but no read permission. */
  url: string | null;
}

export interface StorageRemoveContract {
  deleted: true;
}

export interface ApiEnvelopeContract<T = unknown> {
  status: 0 | 1;
  message: string;
  data?: T;
}

export function isApiEnvelope(value: unknown): value is ApiEnvelopeContract {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Record<string, unknown>;
  return (envelope.status === 0 || envelope.status === 1) && typeof envelope.message === 'string';
}

export function isStorageUpload(value: unknown): value is StorageUploadContract {
  if (!value || typeof value !== 'object') return false;
  const upload = value as Record<string, unknown>;
  const file = upload.file as Record<string, unknown> | undefined;
  return Boolean(file && typeof file.id === 'string' && (upload.url === null || typeof upload.url === 'string'));
}

export const REALTIME_TOPIC_EVENTS = {
  join: 'rt:join',
  leave: 'rt:leave',
  message: 'rt:msg',
} as const;

export type RealtimeTopicMessageType = 'broadcast' | 'presence' | 'postgres_changes' | 'system';

export interface RealtimePostgresChangeConfig {
  event: 'INSERT' | 'UPDATE' | 'DELETE' | '*';
  schema?: string;
  table: string;
  filter?: string;
}

export interface RealtimeJoinConfig {
  broadcast?: { self?: boolean };
  presence?: { key?: string };
  postgres_changes?: RealtimePostgresChangeConfig[];
  /**
   * A private channel is authorized by the RLS policies on `realtime.messages`
   * (SELECT to receive, INSERT to send) and is a separate audience from the
   * public channel of the same topic.
   */
  private?: boolean;
}

export interface RealtimeJoinAck {
  status: 'ok' | 'error';
  /** Server includes the matching binding id in each postgres_changes envelope. */
  bindingIds?: boolean;
  postgres_changes?: Array<{ id: number }>;
  error?: string;
}

export interface RealtimeTopicEnvelope {
  topic: string;
  /** One-based position in the joined postgres_changes configuration. */
  bindingId?: number;
  type: RealtimeTopicMessageType;
  event: string;
  payload: unknown;
}

// 1–255 printable ASCII characters (no control chars, no newlines).
const REALTIME_TOPIC = /^[\x20-\x7E]{1,255}$/;

/** A realtime channel topic: 1–255 printable ASCII chars. */
export function isValidRealtimeTopic(topic: unknown): topic is string {
  return typeof topic === 'string' && REALTIME_TOPIC.test(topic);
}

/**
 * Socket.IO room name for a channel topic. Private channels get their own
 * prefix, so a public subscriber to `room:1` never shares a room (and so never
 * a message) with the private channel of the same name.
 */
export function realtimeTopicRoom(topic: string, isPrivate = false): string {
  return `${isPrivate ? 'rtp' : 'rt'}:${topic}`;
}
