export function looksLikeJson(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return false;
  try { JSON.parse(trimmed); return true; } catch { return false; }
}
