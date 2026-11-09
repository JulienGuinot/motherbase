export interface EdgeFn {
  id: string;
  name: string;
  route: string;
  code: string;
  enabled: boolean;
  /** Callable with no session and no invoke token. */
  isPublic: boolean;
  schedule: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvokeResult {
  value: unknown;
  stdout: string;
  error: string | null;
  durationMs: number;
}

export interface FnLog {
  id: string;
  status: number;
  durationMs: number;
  stdout: string;
  errorMessage: string | null;
  invokedAt: string;
}

export interface Secret {
  id: string;
  name: string;
  preview: string;
  updatedAt: string;
}
