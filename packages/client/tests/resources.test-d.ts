import { describe, it, expectTypeOf } from 'vitest';
import { createClient } from '../src/index.js';
import type { BucketName, DefaultSchemaName, EdgeFunctionName, SchemaNames } from '../src/index.js';

// Type-level only: `vitest --typecheck` compiles this file. The shape is what
// `motherbase gen types typescript` emits (apps/server/tests/fixtures/typegen-golden.ts).
type Database = {
  __InternalMotherbase: {
    EdgeFunctions: 'send-email' | 'stripe-webhook';
    Buckets: 'avatars';
  };
  shop: {
    Tables: { [_ in never]: never };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

describe('project resources from the generated Database', () => {
  it('offers the known names and still takes one created after generation', () => {
    expectTypeOf<'send-email'>().toMatchTypeOf<EdgeFunctionName<Database>>();
    expectTypeOf<'avatars'>().toMatchTypeOf<BucketName<Database>>();
    expectTypeOf<'created-in-studio'>().toMatchTypeOf<EdgeFunctionName<Database>>();

    const client = createClient<Database>('http://localhost', 'key');
    client.functions.invoke('send-email');
    client.functions.invoke('created-in-studio');
    client.storage.from('avatars');
    expectTypeOf(client.functions.invoke).parameter(0).toEqualTypeOf<EdgeFunctionName<Database>>();
    expectTypeOf(client.storage.from).parameter(0).toEqualTypeOf<BucketName<Database>>();
  });

  // Without `public`, the default schema is "the only one": the resources key must not count.
  it('never mistakes the resources key for a schema', () => {
    expectTypeOf<SchemaNames<Database>>().toEqualTypeOf<'shop'>();
    expectTypeOf<DefaultSchemaName<Database>>().toEqualTypeOf<'shop'>();
  });

  it('types a file from before the resources key as plain strings', () => {
    type Old = Omit<Database, '__InternalMotherbase'>;
    expectTypeOf<EdgeFunctionName<Old>>().toEqualTypeOf<string & {}>();
    expectTypeOf<BucketName<Old>>().toEqualTypeOf<string & {}>();
  });
});
