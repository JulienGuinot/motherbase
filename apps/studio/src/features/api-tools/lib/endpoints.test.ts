import { describe, expect, it } from 'vitest';
import { buildEndpoints, identityFilter, type RestResource } from '@/features/api-tools/lib/endpoints';

function resource(over: Partial<RestResource> & { name: string }): RestResource {
  return {
    path: `/rest/v1/${over.name}`,
    primaryKey: ['id'],
    rlsEnabled: true,
    columns: [
      { name: 'id', type: 'uuid', nullable: false, hasDefault: true, isPrimaryKey: true, isGenerated: false },
      { name: 'title', type: 'text', nullable: false, hasDefault: false, isPrimaryKey: false, isGenerated: false },
    ],
    ...over,
  };
}

describe('identityFilter', () => {
  it('uses the table s real key rather than assuming "id"', () => {
    // This was hardcoded to `id=eq.:id`, so a table keyed on `slug` got
    // documented mutations filtering a column it does not have.
    expect(identityFilter(['slug'])).toBe('slug=eq.:slug');
  });

  it('conjoins every column of a composite key', () => {
    expect(identityFilter(['org_id', 'user_id'])).toBe('org_id=eq.:org_id&user_id=eq.:user_id');
  });

  it('produces no filter for a table with no key', () => {
    expect(identityFilter([])).toBe('');
  });
});

describe('buildEndpoints', () => {
  it('builds mutations around the real key', () => {
    const endpoints = buildEndpoints([resource({ name: 'posts', primaryKey: ['slug'] })]);
    const patch = endpoints.find(e => e.group === 'posts' && e.method === 'PATCH');
    expect(patch?.path).toBe('/rest/v1/posts?slug=eq.:slug');
  });

  it('says so when a table has no key to filter on', () => {
    const endpoints = buildEndpoints([resource({ name: 'events', primaryKey: [] })]);
    const del = endpoints.find(e => e.group === 'events' && e.method === 'DELETE');
    expect(del?.path).toBe('/rest/v1/events');
    expect(del?.desc).toContain('no primary key');
  });

  it('keeps generated and key columns out of the sample body', () => {
    const endpoints = buildEndpoints([
      resource({
        name: 'posts',
        columns: [
          { name: 'id', type: 'uuid', nullable: false, hasDefault: true, isPrimaryKey: true, isGenerated: false },
          { name: 'seq', type: 'int4', nullable: false, hasDefault: true, isPrimaryKey: false, isGenerated: true },
          { name: 'title', type: 'text', nullable: false, hasDefault: false, isPrimaryKey: false, isGenerated: false },
        ],
      }),
    ]);
    const body = JSON.parse(endpoints.find(e => e.group === 'posts' && e.method === 'POST')!.sampleBody!);
    expect(Object.keys(body)).toEqual(['title']);
  });

  it('documents nothing beyond the resources the server reports', () => {
    // The list used to be the Studio table list for the selected schema, so
    // picking `auth` advertised /rest/v1 routes the server refuses by design.
    const groups = new Set(buildEndpoints([]).map(e => e.group));
    expect(groups.has('posts')).toBe(false);
    // The static admin routes are still there.
    expect(groups.has('SQL')).toBe(true);
  });
});
