// ── value encoding ───────────────────────────────────────────────────────────

import { PostgrestArrayOperand, PostgrestIsValue, PostgrestPrimitive, ReferencedTableOption } from "./types.js";

/**
 * Characters that end a token in the PostgREST grammar (or in a Postgres array
 * literal). A string value carrying any of them has to be quoted or the server
 * reads a different filter than the caller wrote.
 */
const NEEDS_QUOTING = /[,.:()"\\{}\s]/;

function quoteLiteral(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** One scalar value: quoted only when it has to be. */
export function encodeLiteral(value: PostgrestPrimitive): string {
    if (value === null) return 'null';
    if (typeof value !== 'string') return String(value);
    if (value === '' || NEEDS_QUOTING.test(value)) return quoteLiteral(value);
    return value;
}

/** `in.(a,"b,c")` and the `(all)` / `(any)` modifier lists. */
export function encodeList(values: readonly PostgrestPrimitive[]): string {
    return `(${values.map(encodeLiteral).join(',')})`;
}

/** A Postgres array literal: `{a,"b,c"}`. Used by `cs`, `cd`, `ov` and the like modifiers. */
export function encodeArrayLiteral(values: readonly PostgrestPrimitive[]): string {
    return `{${values.map(encodeLiteral).join(',')}}`;
}

/**
 * The operand of `cs` / `cd` / `ov`, which is polymorphic in PostgREST:
 * an array column takes `{a,b}`, a range column takes its own literal
 * (`[2000-01-01,2000-01-31]`) and a jsonb column takes JSON. A string is passed
 * through untouched because it is already one of the last two.
 */
export function encodeArrayOperand(value: PostgrestArrayOperand): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return encodeArrayLiteral(value as readonly PostgrestPrimitive[]);
    return JSON.stringify(value);
}

/** Values handed to `not()` / `filter()`: strings verbatim, arrays as a list. */
export function encodeRawOperand(value: PostgrestPrimitive | readonly PostgrestPrimitive[]): string {
    if (Array.isArray(value)) return encodeList(value as readonly PostgrestPrimitive[]);
    if (value === null) return 'null';
    return String(value);
}

export function isValueOf(value: PostgrestIsValue): 'null' | 'true' | 'false' | 'unknown' {
    if (value === null) return 'null';
    if (value === true) return 'true';
    if (value === false) return 'false';
    if (value === 'null' || value === 'true' || value === 'false' || value === 'unknown') return value;
    // Programmer misuse, not an API error: fail loudly rather than emit a filter
    // the server will reject with an opaque 400.
    throw new TypeError(`is() accepts null, true, false or unknown, received ${JSON.stringify(value)}`);
}

export function referenced(options: ReferencedTableOption | undefined): string {
    return options?.referencedTable ?? options?.foreignTable ?? '';
}

export function scopedKey(prefix: string, name: string): string {
    return prefix ? `${prefix}.${name}` : name;
}

/** `0-9/57` -> 57. An unknown total (a star after the slash) and a missing header both give null. */
export function parseContentRange(header: string | null): number | null {
    if (!header) return null;
    const total = header.split('/')[1];
    if (!total || total === '*') return null;
    const parsed = Number(total);
    return Number.isFinite(parsed) ? parsed : null;
}


export function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}