'use client';

import { METHOD_COLOR, type Endpoint } from '@/features/api-tools/lib/endpoints';

/** The routes inside the selected group. */
export function EndpointList({
  group,
  endpoints,
  selected,
  onSelect,
  onContextMenu,
}: {
  group: string;
  endpoints: Endpoint[];
  selected: Endpoint | null;
  onSelect: (endpoint: Endpoint) => void;
  onContextMenu: (event: React.MouseEvent, endpoint: Endpoint) => void;
}) {
  return (
    <aside className="flex h-[210px] w-full shrink-0 flex-col overflow-hidden border-b hairline md:h-auto md:w-[260px] md:border-b-0 md:border-r">
      <div className="flex items-center gap-2 border-b hairline px-4 py-3">
        <span className="text-[15px]" style={{ fontWeight: 600 }}>
          {group}
        </span>
        <span className="chip ml-auto">{endpoints.length}</span>
      </div>

      <ul className="flex-1 overflow-auto">
        {endpoints.map((endpoint, index) => (
          <li key={`${endpoint.method}-${endpoint.path}-${index}`} onContextMenu={e => onContextMenu(e, endpoint)}>
            <button
              onClick={() => onSelect(endpoint)}
              className="flex w-full items-center gap-2 border-b hairline px-3 py-2.5 text-left"
              style={{ background: selected === endpoint ? 'var(--hover)' : 'transparent' }}
            >
              <span className="mono w-12 shrink-0 text-[10px]" style={{ color: METHOD_COLOR[endpoint.method] }}>
                {endpoint.method}
              </span>
              <span className="mono truncate text-[11px]">{endpoint.path}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
