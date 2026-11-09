import { describe, it, expectTypeOf } from 'vitest';
import type { CookieMethods } from '@motherbase/client';
import { createBrowserClient } from '../src/browser.js';
import { createServerClient } from '../src/server.js';

// The SSR factories must forward the generated `Database` type exactly like
// `createClient<Database>` does. Nothing here runs; `vitest --typecheck`
// compiles it, and an unused `@ts-expect-error` fails the suite.

type Database = {
  public: {
    Tables: {
      products: {
        Row: { id: string; name: string };
        Insert: { id?: string; name: string };
        Update: { id?: string; name?: string };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

declare const cookies: CookieMethods;

describe('SSR clients are typed by Database', () => {
  it('createBrowserClient<Database> types rows and rejects unknown tables', async () => {
    const client = createBrowserClient<Database>('http://localhost', 'key');
    const { data } = await client.from('products').select('id, name');
    expectTypeOf(data).toEqualTypeOf<{ id: string; name: string }[] | null>();
    // @ts-expect-error not a table of Database
    client.from('nope');
  });

  it('createServerClient<Database> types rows and rejects unknown tables', async () => {
    const client = createServerClient<Database>('http://localhost', 'key', { cookies });
    const { data } = await client.from('products').select('id, name');
    expectTypeOf(data).toEqualTypeOf<{ id: string; name: string }[] | null>();
    // @ts-expect-error not a table of Database
    client.from('nope');
  });
});
