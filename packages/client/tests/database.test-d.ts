import { describe, it, expectTypeOf } from 'vitest';
import { createClient } from '../src/index.js';
import type { MotherbaseResponse } from '../src/types.js';
import type { PostgrestResponse } from '../src/postgrest/index.js';

// Phase 3.5: type-level tests. Nothing here runs; `vitest --typecheck` compiles
// the file and fails on any error, and `expectTypeOf` assertions are checked at
// compile time. A regression in inference is a build failure, not a silent
// widening to `any` that nobody notices until a user hits it.

// A hand-written stand-in for the output of `motherbase gen types typescript`,
// kept small on purpose. Its shape is byte-compatible with the real emitter's
// (see apps/server/tests/fixtures/typegen-golden.ts).
type Database = {
  public: {
    Tables: {
      products: {
        Row: {
          id: string;
          name: string;
          price: number;
          status: Database['public']['Enums']['product_status'];
          notes: string | null;
        };
        Insert: {
          id?: string;
          name: string;
          price: number;
          status?: Database['public']['Enums']['product_status'];
          notes?: string | null;
        };
        Update: {
          id?: string;
          name?: string;
          price?: number;
          status?: Database['public']['Enums']['product_status'];
          notes?: string | null;
        };
        Relationships: [];
      };
    };
    Views: {
      product_names: {
        Row: { id: string | null; name: string | null };
        Relationships: [];
      };
    };
    Functions: {
      price_of: {
        Args: { product: string };
        Returns: number;
      };
      restock: {
        Args: { product: string; quantity?: number };
        Returns: Database['public']['Tables']['products']['Row'][];
      };
    };
    Enums: {
      product_status: 'draft' | 'live';
    };
    CompositeTypes: Record<PropertyKey, never>;
  };
};

const client = createClient<Database>('http://api.test', 'anon');
const untyped = createClient('http://api.test');

describe('a plain select', () => {
  it('infers the full row for select()', async () => {
    const { data } = await client.from('products').select('*');
    expectTypeOf(data).toEqualTypeOf<Database['public']['Tables']['products']['Row'][] | null>();
  });

  it('narrows to the named columns', async () => {
    const { data } = await client.from('products').select('id,name');
    expectTypeOf(data).toEqualTypeOf<{ id: string; name: string }[] | null>();
  });

  it('tolerates whitespace and honours an alias', async () => {
    const { data } = await client.from('products').select('id, label:name');
    expectTypeOf(data).toEqualTypeOf<{ id: string; label: string }[] | null>();
  });

  it('keeps the enum column typed as its label union', async () => {
    const { data } = await client.from('products').select('status');
    expectTypeOf(data).toEqualTypeOf<{ status: 'draft' | 'live' }[] | null>();
  });

  it('rejects a column the relation does not have', () => {
    // @ts-expect-error `bogus` is not a column of products
    client.from('products').select('id,bogus');
  });

  it('rejects a relation the schema does not have', () => {
    // @ts-expect-error `widgets` is not a table or view
    client.from('widgets');
  });

  it('reads views as well as tables', async () => {
    const { data } = await client.from('product_names').select('name');
    expectTypeOf(data).toEqualTypeOf<{ name: string | null }[] | null>();
  });

  it('single() resolves one row rather than an array', async () => {
    const { data } = await client.from('products').select('id,price').single();
    expectTypeOf(data).toEqualTypeOf<{ id: string; price: number } | null>();
  });
});

describe('a filtered select', () => {
  it('keeps the selected shape through filters and modifiers', async () => {
    const { data } = await client
      .from('products')
      .select('id,name')
      .eq('status', 'live')
      .gt('price', 10)
      .order('name', { ascending: false })
      .limit(5);
    expectTypeOf(data).toEqualTypeOf<{ id: string; name: string }[] | null>();
  });

  it('rejects filtering on an unknown column', () => {
    // @ts-expect-error `colour` is not a column of products
    client.from('products').select('*').eq('colour', 'red');
  });
});

describe('the 2.10 builder surface', () => {
  it('keeps the selected shape through the new filters and modifiers', async () => {
    const { data } = await client
      .from('products')
      .select('id,name')
      .or('price.gt.10,price.lt.5')
      .not('status', 'eq', 'draft')
      .filter('price', 'gte', 3)
      .match({ status: 'live' })
      .textSearch('name', 'tea', { type: 'websearch', config: 'english' })
      .contains('notes', ['a'])
      .rangeGt('price', '[1,10)')
      .likeAnyOf('name', ['*tea*'])
      .is('notes', null)
      .order('name', { ascending: false, nullsFirst: true, referencedTable: 'reviews' })
      .limit(5, { referencedTable: 'reviews' })
      .range(0, 9)
      .abortSignal(new AbortController().signal);
    expectTypeOf(data).toEqualTypeOf<{ id: string; name: string }[] | null>();
  });

  it('exposes the count when one was asked for', async () => {
    const result = await client.from('products').select('*', { count: 'exact', head: true });
    expectTypeOf(result.count).toEqualTypeOf<number | null>();
  });

  it('still rejects an unknown column on a new filter', () => {
    // @ts-expect-error `colour` is not a column of products
    client.from('products').select('*').contains('colour', ['red']);
  });

  it('returns<T>() re-types the rows', async () => {
    const { data } = await client.from('products').select('*').returns<{ total: number }>();
    expectTypeOf(data).toEqualTypeOf<{ total: number }[] | null>();
  });

  it('csv() resolves text', async () => {
    const { data } = await client.from('products').select('*').csv();
    expectTypeOf(data).toEqualTypeOf<string | null>();
  });
});

describe('insert and update', () => {
  it('accepts the Insert shape, with defaulted columns optional', () => {
    client.from('products').insert({ name: 'Tea', price: 12 });
    client.from('products').insert([{ name: 'Tea', price: 12, status: 'live' }]);
  });

  it('rejects a missing required column', () => {
    // @ts-expect-error `price` has no default and is not nullable
    client.from('products').insert({ name: 'Tea' });
  });

  it('rejects a value that is not in the enum', () => {
    // @ts-expect-error `archived` is not a product_status label
    client.from('products').insert({ name: 'Tea', price: 1, status: 'archived' });
  });

  it('accepts a partial Update', () => {
    client.from('products').update({ price: 15 });
  });

  it('resolves data: null for a write without .select(), as the server returns nothing', async () => {
    const inserted = await client.from('products').insert({ name: 'Tea', price: 12 });
    expectTypeOf(inserted.data).toEqualTypeOf<null>();
    const updated = await client.from('products').update({ price: 15 }).eq('id', 'p1');
    expectTypeOf(updated.data).toEqualTypeOf<null>();
    const single = await client.from('products').delete().eq('id', 'p1').single();
    expectTypeOf(single.data).toEqualTypeOf<null>();
  });

  it('resolves the rows once .select() asks for them back', async () => {
    const { data } = await client.from('products').insert({ name: 'Tea', price: 12 }).select('id, name');
    expectTypeOf(data).toEqualTypeOf<{ id: string; name: string }[] | null>();
    const one = await client.from('products').upsert({ name: 'Tea', price: 12 }).select().single();
    expectTypeOf(one.data).toEqualTypeOf<Database['public']['Tables']['products']['Row'] | null>();
  });
});

describe('rpc', () => {
  it('types the arguments and the return value from Functions', async () => {
    const { data } = await client.rpc('price_of', { product: 'p1' });
    expectTypeOf(data).toEqualTypeOf<number | null>();

    // Since 2.10 every data call also resolves a `count`, which is `null`
    // unless `{ count }` was requested. `data` is unchanged.
    const restocked = await client.rpc('restock', { product: 'p1' });
    expectTypeOf(restocked).toEqualTypeOf<
      PostgrestResponse<Database['public']['Tables']['products']['Row'][]>
    >();
    expectTypeOf(restocked.error).toEqualTypeOf<MotherbaseResponse<never>['error']>();
  });

  it('rejects an unknown function and a wrong argument type', () => {
    // @ts-expect-error no such function
    client.rpc('teleport', {});
    // @ts-expect-error `product` must be a string
    client.rpc('price_of', { product: 42 });
  });
});

describe('backwards compatibility', () => {
  it('an untyped client still accepts any relation and any column', async () => {
    const { data } = await untyped.from('anything').select('*').eq('c', 1);
    expectTypeOf(data).toEqualTypeOf<Record<string, unknown>[] | null>();
    // Naming columns is still allowed; without a schema their type is unknown.
    const named = await untyped.from('anything').select('a,b');
    expectTypeOf(named.data).toEqualTypeOf<{ a: unknown; b: unknown }[] | null>();
  });

  it('the pre-generics explicit-row form still infers', async () => {
    const { data } = await untyped
      .from<{ id: string; name: string; price: number }>('products')
      .select('id,name');
    expectTypeOf(data).toEqualTypeOf<{ id: string; name: string }[] | null>();
  });
});

describe('the embedded-select seam', () => {
  it('does not narrow an embedded select yet, and does not lie about it', async () => {
    // Relational embedding is Phase 2.7. Until the server resolves it, an
    // embedded select keeps the base row and leaves the embedded keys open
    // rather than inventing a nested shape.
    const { data } = await client.from('products').select('id,name,category(*)');
    expectTypeOf(data).not.toBeNever();
    expectTypeOf(data!).toBeArray();
  });
});

describe('client.db', () => {
  it('types each table from the generated Database', async () => {
    const rows = await client.db.products.findMany({ where: { price: { gt: 10 } } });
    expectTypeOf(rows).toEqualTypeOf<Database['public']['Tables']['products']['Row'][]>();
  });

  it('narrows to the selected columns', async () => {
    const row = await client.db.products.findFirst({ select: { id: true, price: true } });
    expectTypeOf(row).toEqualTypeOf<{ id: string; price: number } | null>();
  });

  it('checks inserts against the Insert shape', () => {
    // @ts-expect-error `price` is required on insert
    void client.db.products.create({ data: { name: 'x' } });
  });

  it('rejects unknown tables and columns', () => {
    // @ts-expect-error `widgets` is not a table or view
    void client.db.widgets;
    // @ts-expect-error `bogus` is not a column of products
    void client.db.products.findMany({ where: { bogus: 1 } });
  });
});
