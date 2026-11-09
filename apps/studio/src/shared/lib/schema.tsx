import { createContext, useContext } from 'react';

/** Schemas Motherbase owns; user tables live in `public`. */
export const SYSTEM_SCHEMAS = new Set(['auth', 'storage', 'platform']);

// Active Postgres schema, persisted. Scopes schema-driven surfaces (Table
// Editor list, Database functions/triggers/extensions, graph). Default 'public'.
export const SchemaCtx = createContext<{ schema: string; setSchema: (s: string) => void }>({
  schema: 'public',
  setSchema: () => {},
});


export const useSchema = () => useContext(SchemaCtx);
