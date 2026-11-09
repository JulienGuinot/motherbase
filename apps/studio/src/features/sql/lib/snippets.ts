import type { ContentFolder, ContentItem } from '@/shared/lib/content';

export type Snippet = ContentItem<'sql'>;

export interface SnippetSection {
  key: string;
  label: string;
  /** Set when the section is one of the caller's folders, so it can be renamed or deleted. */
  folder?: ContentFolder;
  snippets: Snippet[];
}

/**
 * Lays the visible snippets out the way the panel shows them: favourites on
 * top, then the caller's folders, then what teammates shared, then the rest.
 * A snippet appears once, in the first section that claims it. Folders are
 * listed even when empty, otherwise a new one would not appear until used.
 */
export function groupSnippets(snippets: Snippet[], folders: ContentFolder[], operator: string | null): SnippetSection[] {
  const mine = (snippet: Snippet) => snippet.ownerId === operator;
  const favorites = snippets.filter(s => s.favorite && mine(s));
  const taken = new Set(favorites.map(s => s.id));
  const unclaimed = (s: Snippet) => !taken.has(s.id);

  const byFolder: SnippetSection[] = folders.map(folder => ({
    key: folder.id,
    label: folder.name,
    folder,
    snippets: snippets.filter(s => unclaimed(s) && mine(s) && s.folderId === folder.id),
  }));
  byFolder.forEach(section => section.snippets.forEach(s => taken.add(s.id)));

  const shared = snippets.filter(s => unclaimed(s) && !mine(s));
  shared.forEach(s => taken.add(s.id));
  const rest = snippets.filter(unclaimed);

  return [
    { key: 'favorites', label: 'Favorites', snippets: favorites },
    ...byFolder,
    { key: 'shared', label: 'Shared with the project', snippets: shared },
    { key: 'rest', label: 'Snippets', snippets: rest },
  ].filter(section => section.folder || section.snippets.length > 0);
}
