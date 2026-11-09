export interface AdminUser {
  id: string;
  email: string;
  username: string;
  firstName?: string | null;
  lastName?: string | null;
  role: 'USER' | 'ADMIN';
  status: string;
  emailVerified: boolean;
  providers: string[];
  createdAt?: string;
  /** Uploaded avatar. Null for most rows: the column is nullable. */
  imageUrl?: string | null;
  /** Better Auth's own avatar column, set by social sign-in. */
  image?: string | null;
  /** A guest from signInAnonymously(), until it links an email or a provider. */
  isAnonymous?: boolean | null;
}

export type RoleFilter = 'all' | 'ADMIN' | 'USER';
export type VerifFilter = 'all' | 'verified' | 'unverified';
export type AccountFilter = 'all' | 'permanent' | 'anonymous';

export type UserAction = 'promote' | 'demote' | 'revoke-sessions';

interface UserSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  /** Operator id when this session was opened by impersonation, else null. */
  impersonatedBy?: string | null;
}

export interface ImpersonationSession {
  token: string;
  sessionId: string;
  expiresAt: string;
  user: { id: string; email: string; username: string | null };
}

export interface UserDetail extends AdminUser {
  sessions?: UserSession[];
  activeSessions?: number;
}

/** One row of the project-wide Sessions view: a UserSession plus who it belongs to. */
export interface ProjectSession extends UserSession {
  userId: string;
  userEmail: string | null;
  userName: string | null;
}

export type SocialEntry = {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  audiences?: string;
  clientIds?: string;
  [key: string]: unknown;
};

export type CustomEntry = {
  providerId: string;
  clientId: string;
  clientSecret?: string;
  discoveryUrl?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  scopes?: string[];
  [key: string]: unknown;
};
