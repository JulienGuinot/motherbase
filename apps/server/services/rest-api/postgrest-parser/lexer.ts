// Lexical layer: splitting a query string into parts without losing quoting,
// and reading a single column reference (with its optional json path and cast).
// Nothing here knows what a filter or a select means.

import { parseError } from './ast';
import type { JsonPathStep } from './ast';
// ── Lexical helpers ──────────────────────────────────────────────────────────

/**
 * Reserved query parameters: everything else is a column filter.
 *
 * `on_conflict` and `columns` are listed even though nothing consumes them yet
 * (2.5/2.6). Leaving them out would make `?on_conflict=email` parse as a filter
 * on a column named `on_conflict` and fail with a confusing "unknown column".
 */
export const RESERVED_PARAMS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);

/** Hard ceiling on rows, tightened further by the console `api.rest.maxRows`. */
export const MAX_TAKE = 1000;

/** What the scan below ended on, so a caller can reject a malformed input. */
interface ScanEnd {
  depth: number;
  quoted: boolean;
  escaped: boolean;
}

/**
 * Walk `input` once, calling `visit` only for characters that sit at bracket
 * depth zero and outside a double-quoted segment (`\` escapes honoured inside
 * one). `visit` returning true stops the walk.
 *
 * This is THE primitive that makes `in.("a,b",c)` and
 * `or=(a.eq.1,and(b.gt.2,c.is.null))` parse correctly, so the quoting and
 * nesting rules exist exactly once rather than once per caller.
 */
function scanTopLevel(input: string, visit: (char: string, index: number) => boolean | void): ScanEnd {
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted) {
      if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === '(' || char === '{' || char === '[') depth += 1;
    else if (char === ')' || char === '}' || char === ']') depth -= 1;
    else if (depth === 0 && visit(char, index)) break;
  }

  return { depth, quoted, escaped };
}

/**
 * Split on `separator` at nesting depth zero, honouring double-quoted segments
 * and `\` escapes inside them.
 */
export function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;

  const end = scanTopLevel(input, (char, index) => {
    if (char !== separator) return;
    parts.push(input.slice(start, index));
    start = index + 1;
  });

  if (end.quoted || end.escaped) throw parseError(`Unterminated quoted value in "${input}"`);
  if (end.depth !== 0) throw parseError(`Unbalanced brackets in "${input}"`);
  parts.push(input.slice(start));
  return parts;
}

/** Index of the first of `chars` at depth zero and outside quotes, or -1. */
export function indexOfTopLevel(input: string, chars: string): number {
  let found = -1;
  scanTopLevel(input, (char, index) => {
    if (!chars.includes(char)) return;
    found = index;
    return true;
  });
  return found;
}

/**
 * Strip PostgREST's optional double quotes from a single value and decode `\"`
 * and `\\`. Only a fully quoted token is unquoted, so `eq."null"` is the string
 * "null" while `eq.null` stays the (untyped) literal `null`.
 */
export function unquote(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const body = raw.slice(1, -1);
  let out = '';
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '\\' && index + 1 < body.length) {
      index += 1;
      out += body[index];
      continue;
    }
    if (body[index] === '"') throw parseError(`Unescaped quote inside quoted value ${raw}`);
    out += body[index];
  }
  return out;
}

/** Peel one layer of `(...)`, `{...}` or `[...]`, or return null if absent. */
export function peel(raw: string, open: string, close: string): string | null {
  if (raw.length >= 2 && raw[0] === open && raw[raw.length - 1] === close) return raw.slice(1, -1);
  return null;
}

// ── Column references and json paths ─────────────────────────────────────────

export const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ColumnRef {
  column: string;
  jsonPath?: JsonPathStep[];
  jsonAsText?: boolean;
}

/**
 * Parse `col`, `"col with space"`, `col->a->>b`, `data->0->>name`.
 *
 * The json separators are matched longest-first (`->>` before `->`) so a text
 * extraction is never mistaken for an object extraction followed by a `>` in a
 * key name.
 */
export function parseColumnRef(raw: string, context: string): ColumnRef {
  const input = raw.trim();
  if (!input) throw parseError(`Empty column reference in ${context}`);

  // The column name itself may be quoted; the json path never is.
  let column: string;
  let rest: string;
  if (input[0] === '"') {
    const end = findClosingQuote(input, context);
    column = unquote(input.slice(0, end + 1));
    rest = input.slice(end + 1);
  } else {
    const arrow = input.indexOf('->');
    column = arrow === -1 ? input : input.slice(0, arrow);
    rest = arrow === -1 ? '' : input.slice(arrow);
  }

  if (!column) throw parseError(`Empty column name in ${context}`);
  if (input[0] !== '"' && !BARE_IDENTIFIER.test(column)) {
    throw parseError(`Invalid column reference "${column}" in ${context}`);
  }
  if (!rest) return { column };

  const steps: JsonPathStep[] = [];
  let asText = false;
  let cursor = rest;
  while (cursor.length) {
    let separatorLength: number;
    if (cursor.startsWith('->>')) separatorLength = 3;
    else if (cursor.startsWith('->')) separatorLength = 2;
    else throw parseError(`Invalid json path segment "${cursor}" in ${context}`);

    if (asText) throw parseError(`json path continues after ->> in ${context}`);
    asText = separatorLength === 3;

    cursor = cursor.slice(separatorLength);
    const next = cursor.indexOf('->');
    const segment = next === -1 ? cursor : cursor.slice(0, next);
    cursor = next === -1 ? '' : cursor.slice(next);

    if (!segment) throw parseError(`Empty json path segment in ${context}`);
    const key = unquote(segment);
    steps.push(/^\d+$/.test(key) ? { kind: 'index', value: key } : { kind: 'key', value: key });
  }

  return { column, jsonPath: steps, jsonAsText: asText };
}

function findClosingQuote(input: string, context: string): number {
  for (let index = 1; index < input.length; index += 1) {
    if (input[index] === '\\') {
      index += 1;
      continue;
    }
    if (input[index] === '"') return index;
  }
  throw parseError(`Unterminated quoted identifier in ${context}`);
}
