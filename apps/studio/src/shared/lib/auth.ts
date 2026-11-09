const ACCESS_KEY = 'console.accessToken';
const REFRESH_KEY = 'console.refreshToken';
const PASSWORD_CHANGE_KEY = 'console.mustChangePassword';
// Why the last sign-out happened, so the login screen can say so instead of
// appearing for no visible reason mid-task. Read once, then discarded.
const SIGN_OUT_REASON_KEY = 'console.signedOutReason';

export type SignOutReason = 'expired';

function readStorage(key: string): string | null {
  return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
}

function writeStorage(key: string, value: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

let accessToken: string | null = readStorage(ACCESS_KEY);
let passwordChangeRequired = readStorage(PASSWORD_CHANGE_KEY) === 'true';

interface AuthSessionOptions {
  mustChangePassword?: boolean;
}

export const auth = {
  getAccess: () => accessToken,
  getRefresh: () => readStorage(REFRESH_KEY),
  mustChangePassword: () => passwordChangeRequired,
  set(access: string, refresh?: string, options?: AuthSessionOptions) {
    accessToken = access;
    writeStorage(ACCESS_KEY, access);
    if (refresh) writeStorage(REFRESH_KEY, refresh);
    if (options?.mustChangePassword !== undefined) {
      passwordChangeRequired = options.mustChangePassword;
      writeStorage(PASSWORD_CHANGE_KEY, passwordChangeRequired ? 'true' : null);
    }
  },
  requirePasswordChange() {
    passwordChangeRequired = true;
    writeStorage(PASSWORD_CHANGE_KEY, 'true');
  },
  completePasswordChange() {
    passwordChangeRequired = false;
    writeStorage(PASSWORD_CHANGE_KEY, null);
  },
  clear(reason?: SignOutReason) {
    accessToken = null;
    passwordChangeRequired = false;
    writeStorage(ACCESS_KEY, null);
    writeStorage(REFRESH_KEY, null);
    writeStorage(PASSWORD_CHANGE_KEY, null);
    writeStorage(SIGN_OUT_REASON_KEY, reason ?? null);
  },
  /** Consume the reason for the last involuntary sign-out, if there was one. */
  takeSignOutReason(): SignOutReason | null {
    const reason = readStorage(SIGN_OUT_REASON_KEY);
    writeStorage(SIGN_OUT_REASON_KEY, null);
    return reason === 'expired' ? reason : null;
  },
  isAuthed: () => Boolean(accessToken),
};
