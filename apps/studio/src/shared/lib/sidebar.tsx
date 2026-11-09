import { createContext, useContext } from 'react';

// Persisted preference for the left nav rail's expansion behaviour.
//  - 'expanded'  : always wide (icons + labels), pushes content.
//  - 'collapsed' : always thin (icons only).
//  - 'hover'     : thin by default, expands as an overlay on hover (Supabase-style).
export type SidebarMode = 'expanded' | 'collapsed' | 'hover';

export interface SidebarContextValue {
  mode: SidebarMode;
  setMode: (m: SidebarMode) => void;
}

export const SidebarCtx = createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const context = useContext(SidebarCtx);
  if (!context) throw new Error('useSidebar must be used within SidebarProvider');
  return context;
}
