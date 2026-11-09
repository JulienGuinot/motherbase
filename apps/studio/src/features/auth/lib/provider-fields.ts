export function mergeProviderEntry<T extends object>(current: T, patch: Partial<T>): T {
  return { ...current, ...patch };
}
