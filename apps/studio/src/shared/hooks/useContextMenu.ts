import { useState } from 'react';

export function useContextMenu<T = unknown>() {
  const [menu, setMenu] = useState<{ x: number; y: number; data: T } | null>(null);

  function onContextMenu(event: React.MouseEvent, data: T) {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, data });
  }

  return { menu, onContextMenu, close: () => setMenu(null) };
}
