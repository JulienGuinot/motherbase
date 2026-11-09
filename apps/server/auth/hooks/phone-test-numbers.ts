/** Parses "phone:code, phone:code" into a phone → code lookup. Blank/malformed entries are dropped. */
export function parsePhoneTestNumbers(raw?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of (raw ?? '').split(',')) {
    const [phone, code] = entry.split(':').map(s => s.trim());
    if (phone && code) out[phone] = code;
  }
  return out;
}
