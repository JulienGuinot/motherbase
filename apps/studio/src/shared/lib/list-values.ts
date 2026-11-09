// Settings that hold a list but are stored as one string ("a, b, c"). The
// server splits them on commas (and whitespace, for most), so these are the
// two directions of that contract plus the checks ListInput flags items with.

/** Split typed or pasted text into items: commas, spaces and newlines all separate. */
export function splitList(raw: string): string[] {
  return raw.split(/[\s,]+/).map(item => item.trim()).filter(Boolean);
}

/** Append items, dropping blanks and anything already in the list. */
export function addToList(current: readonly string[], items: readonly string[]): string[] {
  const next = [...current];
  for (const item of items) if (item && !next.includes(item)) next.push(item);
  return next;
}

/** The stored form. Every server-side parser trims around the comma. */
export function joinList(items: readonly string[]): string {
  return items.join(', ');
}

/** A browser origin: scheme and host, no path. Same rule as the server's manifest check. */
export function originError(value: string, { allowWildcard = false } = {}): string | null {
  if (allowWildcard && value === '*') return null;
  try {
    const url = new URL(value);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value.replace(/\/$/, '')) return null;
  } catch {
    // Not a URL at all: falls through to the message.
  }
  return allowWildcard
    ? 'Expected an origin such as https://app.example.com, or *'
    : 'Expected an origin such as https://app.example.com';
}

/** A `phone:code` test-number pair, as the SMS provider parses it. */
export function phoneCodePairError(value: string): string | null {
  return /^\+?\d{6,15}:\d{4,10}$/.test(value) ? null : 'Expected phone:code, e.g. +15550001111:123456';
}

/**
 * A Postgres function name, with the same bar as the server's `functionNameList`
 * superRefine: anything 63 UTF-8 bytes or less with no control characters is
 * accepted verbatim, so quoted-identifier names like `MyFn` go through. A typo
 * surfaces as a 403 at call time, not here.
 */
export function functionNameError(value: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(value)) return 'Control characters are not allowed in a function name';
  if (new TextEncoder().encode(value).length > 63) return "Over Postgres' 63-byte identifier limit";
  return null;
}

/** A MIME type, with optional `*` wildcard on either side, as `parseMimeList` accepts. */
export function mimeTypeError(value: string): string | null {
  // RFC 6838 allows letters, digits and a few symbols in type names; `*` stands in for either side.
  return /^(\*|[a-z0-9][a-z0-9!#$&^_.+-]*)\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/i.test(value)
    ? null
    : 'Expected type/subtype, e.g. image/png or image/*';
}
