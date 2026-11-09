import { FileStatus, Prisma } from '@prisma/client';

/**
 * Server-side filtering for the storage browser. Filters have to run before
 * the page limit, or a search could never reach a file past the first page.
 */

export type FileCategory = 'image' | 'video' | 'audio' | 'doc' | 'archive' | 'other';

export interface FileListFilters {
  page?: number;
  pageSize?: number;
  /** Matches key, bucket name or owner email. */
  q?: string;
  category?: FileCategory | 'all';
  visibility?: 'public' | 'private' | 'all';
}

export const MAX_FILE_PAGE_SIZE = 100;

/**
 * Mime predicates per category. Mirrors `categoryOf` in the console
 * (`features/storage/components/storage.utils.ts`); the two are one contract,
 * so a category added there has to be added here or it silently matches
 * nothing.
 */
const CATEGORY_PREFIXES: Record<Exclude<FileCategory, 'other'>, string[]> = {
  image: ['image/'],
  video: ['video/'],
  audio: ['audio/'],
  doc: ['pdf', 'word', 'excel', 'sheet', 'presentation', 'text'],
  archive: ['zip', 'tar', 'gzip', 'rar', '7z'],
};

function categoryWhere(category: FileCategory): Prisma.FileWhereInput {
  if (category === 'other') {
    // Everything that matches no other category, plus files with no mime at all.
    const matched = Object.values(CATEGORY_PREFIXES).flat();
    return {
      NOT: { OR: matched.map(needle => ({ mime: { contains: needle, mode: 'insensitive' as const } })) },
    };
  }
  const needles = CATEGORY_PREFIXES[category];
  return { OR: needles.map(needle => ({ mime: { contains: needle, mode: 'insensitive' as const } })) };
}

/** Build the `where` a file listing runs, filters included. */
export function buildFileWhere(
  base: Prisma.FileWhereInput,
  filters: FileListFilters = {}
): Prisma.FileWhereInput {
  const clauses: Prisma.FileWhereInput[] = [base, { status: FileStatus.ready }];

  const term = filters.q?.trim();
  if (term) {
    clauses.push({
      OR: [
        { key: { contains: term, mode: 'insensitive' } },
        { bucket: { contains: term, mode: 'insensitive' } },
        { owner: { email: { contains: term, mode: 'insensitive' } } },
      ],
    });
  }

  if (filters.category && filters.category !== 'all') clauses.push(categoryWhere(filters.category));
  if (filters.visibility && filters.visibility !== 'all') clauses.push({ visibility: filters.visibility as never });

  return { AND: clauses };
}

/** Clamp page/pageSize the same way on both listing endpoints. */
export function filePage(filters: FileListFilters = {}): { page: number; take: number; skip: number } {
  const take = Math.min(MAX_FILE_PAGE_SIZE, Math.max(1, Math.floor(Number(filters.pageSize)) || 25));
  const page = Math.max(1, Math.floor(Number(filters.page)) || 1);
  return { page, take, skip: (page - 1) * take };
}

/** Parse the query string of a listing route into filters. */
export function parseFileFilters(query: Record<string, unknown>): FileListFilters {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const category = text(query.category);
  const visibility = text(query.visibility);
  return {
    page: Number(query.page) || undefined,
    pageSize: Number(query.pageSize) || undefined,
    q: text(query.q),
    category: category as FileListFilters['category'],
    visibility: visibility as FileListFilters['visibility'],
  };
}
