/**
 * The little XML the S3 protocol needs, both ways. S3 documents are flat and
 * their element names fixed, so a builder and two extractors cover it without
 * pulling an XML library into the server.
 */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const UNESCAPES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export const escapeXml = (value: string): string => value.replace(/[&<>"']/g, c => ESCAPES[c]);

function unescapeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return UNESCAPES[entity.toLowerCase()];
  });
}

/** An element tree: a value is text, a nested tree, or a list of repeated elements. */
export type XmlNode = { [name: string]: XmlValue };
type XmlValue = string | number | boolean | null | undefined | XmlNode | XmlNode[] | string[];

function render(name: string, value: XmlValue): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return (value as Array<string | XmlNode>).map(item => render(name, item)).join('');
  if (typeof value === 'object') {
    return `<${name}>${Object.entries(value).map(([child, v]) => render(child, v)).join('')}</${name}>`;
  }
  return `<${name}>${escapeXml(String(value))}</${name}>`;
}

/**
 * A complete S3 response document: elements, or bare text for the one-value
 * documents (`LocationConstraint`). Error documents carry no namespace on AWS.
 */
export function xmlDocument(root: string, body: XmlNode | string, { namespaced = true } = {}): string {
  const inner = typeof body === 'string'
    ? escapeXml(body)
    : Object.entries(body).map(([name, value]) => render(name, value)).join('');
  const ns = namespaced ? ' xmlns="http://s3.amazonaws.com/doc/2006-03-01/"' : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${root}${ns}>${inner}</${root}>`;
}

/** Every `<tag>` block in `xml`, as raw inner XML. */
export function xmlBlocks(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  return [...xml.matchAll(pattern)].map(match => match[1]);
}

/** The text of the first `<tag>` in `xml`, unescaped, or undefined. */
export function xmlText(xml: string, tag: string): string | undefined {
  const block = xmlBlocks(xml, tag)[0];
  return block === undefined ? undefined : unescapeXml(block);
}
