import { useEffect, useState, type ReactNode } from 'react';
import { SidebarCtx, type SidebarMode } from '@/shared/lib/sidebar';
import { safeStorage } from '@/shared/lib/safe-storage';

const STORAGE_KEY = 'console.sidebar';
const MODES: SidebarMode[] = ['expanded', 'collapsed', 'hover'];

function readMode(): SidebarMode {
  const raw = safeStorage.get(STORAGE_KEY);
  return MODES.includes(raw as SidebarMode) ? (raw as SidebarMode) : 'hover';
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<SidebarMode>(readMode);

  useEffect(() => {
    safeStorage.set(STORAGE_KEY, mode);
  }, [mode]);

  return <SidebarCtx.Provider value={{ mode, setMode }}>{children}</SidebarCtx.Provider>;
}
