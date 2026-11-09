/** Browser · OS summary for a session's User-Agent string, e.g. "Chrome · macOS". */
export function shortAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Firefox\/[\d.]+/.test(ua) ? 'Firefox'
    : /Edg\/[\d.]+/.test(ua) ? 'Edge'
    : /Chrome\/[\d.]+/.test(ua) ? 'Chrome'
    : /Safari\/[\d.]+/.test(ua) ? 'Safari'
    : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iOS/.test(ua) ? 'iOS'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  return os ? `${browser} · ${os}` : browser;
}
