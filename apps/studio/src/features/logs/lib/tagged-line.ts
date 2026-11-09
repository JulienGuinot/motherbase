/**
 * Every non-HTTP line the server emits is shaped `[tag] rest`, often with a
 * duration and `key=value` metadata in the rest (see `logActivity` calls across
 * `apps/server`). HTTP lines already render as aligned columns; these rendered
 * as one flat grey sentence, which is what made the stream look like two
 * different screens stacked on top of each other.
 *
 * Anything that does not match falls through to the plain renderer, so a
 * producer changing its format degrades to flat text rather than to a wrong row.
 */
export interface TaggedLine {
  /** The bracketed prefix, without its brackets: `job:storage-cleanup`. */
  tag: string;
  /** What is left once the tag, the verdict and the duration are lifted out. */
  rest: string;
  /** `ok in 13ms` / `failed after 42ms` both put their number here. */
  ms?: number;
  /** The verdict, when there is one, so it can be coloured. */
  outcome?: 'ok' | 'failed' | 'error' | 'skipped';
}

const TAGGED = /^\[([^\]\n]{1,48})\]\s*([\s\S]*)$/;
const DURATION = /\s*\b(?:in|after)\s+(\d+)ms\b/;
const OUTCOME = /^(ok|failed|error|skipped)\b/i;
// `[sql:ok] SELECT …` and `[sql:error] …` put the verdict in the tag instead.
const TAG_OUTCOME = /^(ok|failed|error|skipped)$/i;

export function parseTaggedLine(message: string): TaggedLine | null {
  const match = TAGGED.exec(message);
  if (!match) return null;

  let rest = match[2];
  let ms: number | undefined;

  const duration = DURATION.exec(rest);
  if (duration) {
    ms = Number(duration[1]);
    rest = `${rest.slice(0, duration.index)}${rest.slice(duration.index + duration[0].length)}`;
  }

  // Lifting the duration out of the middle of `failed after 42ms, reason`
  // leaves the punctuation stranded; put the sentence back together.
  rest = rest.replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').replace(/^[,.;:]\s*/, '').trim();

  let tag = match[1];
  const leading = OUTCOME.exec(rest);
  let outcome = leading?.[1].toLowerCase() as TaggedLine['outcome'] | undefined;

  // Taken out of `rest` here rather than sliced off by the caller: when the
  // verdict comes from the tag instead (below) there is nothing to slice, and a
  // caller that sliced anyway ate the first letters of the message. `[sql:ok]
  // INSERT INTO …` rendered as `SERT INTO …`.
  if (leading) rest = rest.slice(leading[0].length).replace(/^[,;:\s]+/, '');

  const colon = tag.lastIndexOf(':');
  if (!outcome && colon > 0 && TAG_OUTCOME.test(tag.slice(colon + 1))) {
    outcome = tag.slice(colon + 1).toLowerCase() as TaggedLine['outcome'];
    tag = tag.slice(0, colon);
  }

  return { tag, rest, ms, outcome };
}

/** `socket=abc user=usr_1` reads far better with the keys held back. */
export function splitPairs(rest: string): { key?: string; text: string }[] {
  return rest.split(' ').map(token => {
    const eq = /^([A-Za-z][\w.-]{0,30})=(.*)$/.exec(token);
    return eq ? { key: eq[1], text: eq[2] } : { text: token };
  });
}

export function outcomeColor(outcome: NonNullable<TaggedLine['outcome']>): string {
  if (outcome === 'ok') return 'var(--green)';
  if (outcome === 'failed' || outcome === 'error') return 'var(--red)';
  return 'var(--amber)';
}
