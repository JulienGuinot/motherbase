/** Minimum length accepted anywhere the console sets or changes a password. */
export const MIN_PASSWORD = 8;

/** HTTP methods that never mutate state, so they skip auditing and need read scope only. */
export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
