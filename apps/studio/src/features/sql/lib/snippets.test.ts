import { describe, expect, it } from 'vitest';
import type { ContentFolder } from '@/shared/lib/content';
import { groupSnippets, type Snippet } from '@/features/sql/lib/snippets';

const snippet = (id: string, extra: Partial<Snippet> = {}): Snippet => ({
  id, type: 'sql', name: id, description: null, content: { sql: 'select 1' }, visibility: 'user',
  ownerId: 'me', folderId: null, favorite: false, createdAt: '', updatedAt: '', ...extra,
});
const folder = (id: string): ContentFolder => ({ id, name: id, ownerId: 'me', createdAt: '' });

describe('groupSnippets', () => {
  it('puts each snippet in exactly one section, favourites first', () => {
    const sections = groupSnippets(
      [snippet('fav', { favorite: true, folderId: 'f1' }), snippet('filed', { folderId: 'f1' }), snippet('theirs', { ownerId: 'you', visibility: 'project' }), snippet('plain')],
      [folder('f1')],
      'me',
    );
    expect(sections.map(s => [s.key, s.snippets.map(x => x.id)])).toEqual([
      ['favorites', ['fav']],
      ['f1', ['filed']],
      ['shared', ['theirs']],
      ['rest', ['plain']],
    ]);
  });

  it('keeps an empty folder visible but drops empty built-in sections', () => {
    const sections = groupSnippets([], [folder('f1')], 'me');
    expect(sections.map(s => s.key)).toEqual(['f1']);
  });
});
