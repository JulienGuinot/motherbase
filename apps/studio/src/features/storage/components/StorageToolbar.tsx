import { Grid3x3, List, Search, UploadCloud } from 'lucide-react';
import {
  ALL_FILES_ICON,
  FILE_CATEGORY_FILTERS,
  FILE_CATEGORY_ICONS,
  VISIBILITY_FILTERS,
} from '@/features/storage/components/storage.constants';
import type { FileCategoryFilter, StorageView, VisibilityFilter } from '@/features/storage/components/storage.types';

interface StorageToolbarProps {
  query: string;
  category: FileCategoryFilter;
  visibility: VisibilityFilter;
  view: StorageView;
  onQueryChange: (value: string) => void;
  onCategoryChange: (value: FileCategoryFilter) => void;
  onVisibilityChange: (value: VisibilityFilter) => void;
  onViewChange: (value: StorageView) => void;
  onUpload: () => void;
}

export function StorageToolbar({
  query,
  category,
  visibility,
  view,
  onQueryChange,
  onCategoryChange,
  onVisibilityChange,
  onViewChange,
  onUpload,
}: StorageToolbarProps) {
  return (
    <div className="card flex flex-wrap items-center gap-3 p-3">
      <div
        className="flex flex-1 min-w-[200px] items-center gap-2 border hairline-strong px-3 py-1.5"
        style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
      >
        <Search size={12} style={{ color: 'var(--text-mute)' }} />
        <input
          value={query}
          onChange={event => onQueryChange(event.target.value)}
          placeholder="Search by key, bucket, owner..."
          className="w-full bg-transparent text-[13px] outline-none placeholder:opacity-50"
        />
      </div>

      <div
        className="flex max-w-full overflow-x-auto border hairline-strong"
        style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
      >
        {FILE_CATEGORY_FILTERS.map(item => {
          const Icon = item === 'all' ? ALL_FILES_ICON : FILE_CATEGORY_ICONS[item];
          return (
            <button
              key={item}
              onClick={() => onCategoryChange(item)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px]"
              style={{
                background: category === item ? 'var(--hover)' : 'transparent',
                color: category === item ? 'var(--text)' : 'var(--text-mute)',
              }}
              title={item}
            >
              <Icon size={11} />
              <span className="capitalize hidden md:inline">{item}</span>
            </button>
          );
        })}
      </div>

      <div
        className="flex overflow-hidden border hairline-strong"
        style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
      >
        {VISIBILITY_FILTERS.map(item => (
          <button
            key={item}
            onClick={() => onVisibilityChange(item)}
            className="px-2.5 py-1.5 text-[11px] capitalize"
            style={{
              background: visibility === item ? 'var(--hover)' : 'transparent',
              color: visibility === item ? 'var(--text)' : 'var(--text-mute)',
            }}
          >
            {item}
          </button>
        ))}
      </div>

      <button onClick={onUpload} className="btn btn-primary">
        <UploadCloud size={12} /> Upload
      </button>

      <div
        className="flex overflow-hidden border hairline-strong"
        style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
      >
        <button
          onClick={() => onViewChange('grid')}
          className="px-2.5 py-1.5"
          style={{ background: view === 'grid' ? 'var(--hover)' : 'transparent' }}
          title="Grid"
        >
          <Grid3x3 size={12} />
        </button>
        <button
          onClick={() => onViewChange('list')}
          className="px-2.5 py-1.5"
          style={{ background: view === 'list' ? 'var(--hover)' : 'transparent' }}
          title="List"
        >
          <List size={12} />
        </button>
      </div>
    </div>
  );
}
