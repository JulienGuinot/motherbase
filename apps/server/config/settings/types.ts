// Field and group shapes for the settings registry. See ./index.ts.

import { z } from 'zod';

type FieldType = 'text' | 'number' | 'password' | 'bool' | 'json' | 'select';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  secret?: boolean;
  /** For `json` fields: property names, at each entry of the value, to encrypt + mask. */
  secretKeys?: string[];
  required?: boolean;
  placeholder?: string;
  default?: unknown;
  /** Choices for `select` fields. */
  options?: { value: string; label: string }[];
  /** Render a `text` field as a multi-line textarea. */
  multiline?: boolean;
  /** Hint shown under the field in the console. */
  help?: string;
}

export interface GroupDef {
  key: string;
  label: string;
  /** Optional note rendered above the fields in the console. */
  description?: string;
  fields: FieldDef[];
  schema: z.ZodType<Record<string, unknown>>;
  envFallback: () => Record<string, unknown>;
}

export const SECRET_SENTINEL = '__SECRET_SET__';
